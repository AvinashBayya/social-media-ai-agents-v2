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
  clusterStories,
  corpusTerms,
  detectLanguage,
  type Article,
  type Keyword,
  type StoryCluster,
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

const CARD = "bg-console-surface border-console-border";

function Page() {
  // Empty on both server and first client render — getActiveTarget() reads
  // localStorage, unavailable during SSR. A synchronous getActiveTarget()
  // call here made the server-rendered text differ from the client's first
  // paint (a React hydration mismatch); the mount effect below now sets the
  // real value client-side, after hydration.
  const [target, setTarget] = useState("");
  const [draft, setDraft] = useState("");
  const [corpus, setCorpus] = useState<Article[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    const initial = getActiveTarget();
    setTarget(initial);
    setDraft(initial);

    // Without this, changing the target via the top-nav search bar while
    // already on this page did nothing until navigating away and back.
    const handleTargetChange = (e: any) => {
      if (e.detail) {
        setTarget(e.detail);
        setDraft(e.detail);
      }
    };
    window.addEventListener("sentinel_target_changed", handleTargetChange);
    return () => window.removeEventListener("sentinel_target_changed", handleTargetChange);
  }, []);

  useEffect(() => {
    // Skip the empty placeholder — the mount-sync effect above fills in the
    // real target a moment later, which re-triggers this effect via [target].
    if (!target) return;
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
    return () => {
      cancelled = true;
    };
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
              <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-console-label" />
              <Input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && search()}
                placeholder="Subject to analyse…"
                className="h-8 border-console-border bg-console-deep pl-8 text-[11px] text-console-text"
              />
            </div>
            <Button size="sm" onClick={search} disabled={loading} className="h-8">
              {loading ? <Loader2 className="size-3.5 animate-spin" /> : "Analyse"}
            </Button>
            <span className="font-mono text-[10px] text-console-label">
              {corpus.length} document(s) collected for "{target}"
            </span>
          </div>

          <p className="mt-2 flex items-start gap-1.5 text-[10px] leading-relaxed text-console-label">
            <Info className="mt-px size-3 shrink-0" />
            No growth percentage is shown. That would need a previous collection to compare against
            and nothing stores one — an invented delta is the most convincing-looking number on a
            page like this and the least defensible. No engagement volume either: this collects
            articles, not impressions.
          </p>

          {error && (
            <div className="mt-3 flex items-start gap-2 rounded border border-console-red/30 bg-console-red/5 p-2">
              <AlertTriangle className="size-3.5 shrink-0 text-console-red" />
              <span className="font-mono text-[10px] leading-relaxed text-console-red">{error}</span>
            </div>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        <Card className={CARD}>
          <CardContent className="p-4">
            <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase text-console-text">
              <TrendingUp className="size-3.5 text-console-blue" />
              Dominant terms
            </h3>

            {loading ? (
              <div className="flex items-center gap-2 py-6 text-[11px] text-console-muted">
                <Loader2 className="size-3.5 animate-spin" /> Collecting…
              </div>
            ) : terms.length === 0 ? (
              <p className="mt-3 text-[11px] leading-relaxed text-console-label">
                Not enough collected documents to rank terms. TF-IDF needs at least two documents to
                have anything to be inverse-frequent against, and a term appearing in only one
                document says nothing about the collection.
              </p>
            ) : (
              <>
                <div className="mt-3 space-y-1.5">
                  {terms.map((t) => (
                    <div key={t.term} className="flex items-center gap-2">
                      <span className="w-32 shrink-0 truncate font-mono text-[11px] text-console-text">
                        {t.term}
                      </span>
                      <div className="h-2 flex-1 overflow-hidden rounded-full bg-console-deep">
                        <div
                          className="h-full rounded-full bg-console-blue"
                          style={{ width: `${(t.documentCount / maxDocs) * 100}%` }}
                        />
                      </div>
                      <span
                        className="w-24 shrink-0 text-right font-mono text-[10px] text-console-muted"
                        title={`TF-IDF score ${t.score.toFixed(4)}`}
                      >
                        {t.documentCount}/{corpus.length} docs
                      </span>
                    </div>
                  ))}
                </div>
                <p className="mt-3 text-[10px] leading-relaxed text-console-label">
                  Ranked by TF-IDF across this collection; the bar shows how many collected
                  documents contain the term, which is the part an analyst can check. Hover a row
                  for the raw score.
                </p>
              </>
            )}
          </CardContent>
        </Card>

        <div className="space-y-4">
          <Card className={CARD}>
            <CardContent className="p-4">
              <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase text-console-text">
                <Layers className="size-3.5 text-console-purple" />
                Widest-reaching stories
              </h3>
              {reachingStories.length === 0 ? (
                <p className="mt-2 text-[11px] leading-relaxed text-console-label">
                  {loading
                    ? "Collecting…"
                    : "No story in this collection was carried by more than one independent outlet."}
                </p>
              ) : (
                <div className="mt-2 space-y-2">
                  {reachingStories.slice(0, 6).map((c) => (
                    <div key={c.id} className="rounded border border-console-border bg-console-deep/60 p-2">
                      <p className="line-clamp-2 text-[11px] leading-snug text-console-text">
                        {c.title}
                      </p>
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <Badge
                          variant="outline"
                          className="border-console-purple/40 bg-console-purple/10 text-[9px] font-normal text-console-purple"
                        >
                          {c.independentDomains.length} independent sources
                        </Badge>
                        {c.syndicated && (
                          <Badge
                            variant="outline"
                            className="border-console-amber/40 bg-console-amber/10 text-[9px] font-normal text-console-amber"
                          >
                            {c.syndicatedDomains.length} syndicated collapsed
                          </Badge>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <p className="mt-2 text-[10px] leading-relaxed text-console-label">
                Reach measured as distinct outlets carrying one story, after collapsing syndicated
                copies — counting wire pickups separately is how one story is made to look like
                five.
              </p>
            </CardContent>
          </Card>

          <Card className={CARD}>
            <CardContent className="p-4">
              <h3 className="text-xs font-bold uppercase text-console-text">Language mix</h3>
              {languages.length === 0 ? (
                <p className="mt-2 text-[11px] text-console-label">Nothing collected yet.</p>
              ) : (
                <div className="mt-2 space-y-1">
                  {languages.map(([name, count]) => (
                    <div
                      key={name}
                      className="flex items-center justify-between font-mono text-[10px]"
                    >
                      <span className="truncate text-console-muted">{name}</span>
                      <span className="shrink-0 tabular-nums text-console-text">{count}</span>
                    </div>
                  ))}
                </div>
              )}
              <p className="mt-2 text-[10px] leading-relaxed text-console-label">
                Detected from Unicode script ranges — deterministic, no model call. Scripts carrying
                several languages (Devanagari, Bengali) are reported at script level rather than
                guessed.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </AppShell>
  );
}
