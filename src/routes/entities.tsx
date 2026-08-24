import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { AppShell, PageHeader } from "@/components/app-shell";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Search,
  Loader2,
  AlertTriangle,
  Tags,
  Info,
  ExternalLink,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { getActiveTarget, setActiveTarget } from "@/utils/active-target";
import { fetchNews } from "./news";
import { aiExtractEntities, type AnalysisEntity } from "@/utils/analysis-llm";
import { clusterStories, type Article } from "@/utils/analysis";
import { bandFor, defaultFactors, scoreCorpus, type CredibilityScore } from "@/utils/credibility";
// Single source for the merge key. /graph and this page must key entities
// identically, or one corpus produces two different merged sets on two pages.
import { entityKey } from "@/utils/graph-build";

/**
 * Entity Explorer — Module 2, entity extraction over the live corpus.
 *
 * Every figure on this page was previously invented: a risk score of 88, a
 * "+6 vs 7d" trend, "1,241 mentions", six connected accounts including an email
 * address and a phone number, and six gradient squares captioned "3 documents ·
 * 12 images · 2 videos". None of it came from anywhere.
 *
 * What replaces it: entities extracted by the model from articles actually
 * collected for the target, aggregated across sources, with each entity's
 * supporting sources weighted by Module 1's credibility score. An entity named
 * by two TIER_1 wires is a different proposition from one named by a single
 * unrated blog, and the page says which it is.
 *
 * Extraction is per-article and explicit. Nothing is inferred about the target
 * beyond what the collected text states.
 */

export const Route = createFileRoute("/entities")({
  head: () => ({ meta: [{ title: "Entity Explorer — Sentinel AI" }] }),
  component: Page,
});

const TYPE_COLOURS: Record<string, string> = {
  PERSON: "border-console-blue/30 bg-console-blue/10 text-console-blue",
  ORGANISATION: "border-console-purple/30 bg-console-purple/10 text-console-purple",
  LOCATION: "border-console-green/30 bg-console-green/10 text-console-green",
  EQUIPMENT: "border-console-amber/30 bg-console-amber/10 text-console-amber",
  EVENT: "border-console-cyan/30 bg-console-cyan/10 text-console-cyan",
  OTHER: "border-console-label/30 bg-console-label/10 text-console-muted",
};

const BAND_COLOURS: Record<string, string> = {
  high: "text-console-green",
  medium: "text-console-amber",
  low: "text-console-red",
  unknown: "text-console-label",
};

interface Occurrence {
  articleId: string;
  source: string;
  url: string;
  /** The model's confidence for THIS extraction. Never averaged into a new number. */
  confidence: number;
  mention: string;
  /** Module 1 score for the article, or null when it could not be scored. */
  credibility: number | null;
}

interface AggregatedEntity {
  entity: string;
  type: string;
  occurrences: Occurrence[];
  /** Distinct source domains naming this entity. */
  sourceCount: number;
  /** Highest model confidence observed, with the article it came from. */
  bestConfidence: number;
  /** Best Module 1 credibility among the articles naming it, or null. */
  bestCredibility: number | null;
}

/*
 * `entityKey` moved to utils/graph-build.ts and is imported above.
 *
 * It briefly existed in both places — here and there — which is the exact
 * duplication-drift the evidence store work removed elsewhere in the same
 * session. It matters more than most: the function carries a load-bearing fix
 * (the old character class covered Devanagari through Sinhala only, so every
 * Urdu name, written in Arabic script, was stripped to an empty key and merged
 * into one node). Two copies means one of them eventually loses that fix.
 *
 * /graph and /entities must key entities identically or the same corpus
 * produces two different sets of merged entities on two pages.
 */

function Page() {
  // Empty on both server and first client render — getActiveTarget() reads
  // localStorage, unavailable during SSR. A synchronous getActiveTarget()
  // call here made the server-rendered text differ from the client's first
  // paint (a React hydration mismatch); the effect below now sets the real
  // value client-side, after hydration.
  const [target, setTarget] = useState("");
  const [searchVal, setSearchVal] = useState("");

  const [corpus, setCorpus] = useState<Article[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [extracted, setExtracted] = useState<Record<string, AnalysisEntity[]>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [extractError, setExtractError] = useState("");
  const [model, setModel] = useState("");
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [openEntity, setOpenEntity] = useState<string | null>(null);

  useEffect(() => {
    const initial = getActiveTarget();
    setTarget(initial);
    setSearchVal(initial);

    const handler = (e: any) => {
      if (e.detail) {
        setTarget(e.detail);
        setSearchVal(e.detail);
      }
    };
    window.addEventListener("sentinel_target_changed", handler);
    return () => window.removeEventListener("sentinel_target_changed", handler);
  }, []);

  // Collect a live corpus for the target. Extraction never runs automatically —
  // one model call per article on page load would empty a free tier immediately.
  useEffect(() => {
    // Skip the empty placeholder — the mount-sync effect above fills in the
    // real target a moment later, which re-triggers this effect via [target].
    if (!target) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError("");
      setExtracted({});
      setExtractError("");
      try {
        const res: any = await fetchNews({ data: { query: target } });
        if (cancelled) return;
        const mapped: Article[] = (res?.stories ?? [])
          .map((s: any, i: number) => ({
            id: String(s.id ?? s.primaryLink ?? s.url ?? i),
            title: s.primaryTitle || "",
            source: s.primarySource || "",
            url: s.primaryLink || s.url || "",
            pubDate: s.pubDate || "",
            body: s.body || "",
          }))
          .filter((a: Article) => a.title);
        setCorpus(mapped);
      } catch (err: any) {
        if (!cancelled) setLoadError(err?.message ?? String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [target]);

  // Module 1 scores, shared clustering, default factor weights. The analyst can
  // retune weights on /sources; this page uses the defaults and says so.
  const scores = useMemo<Map<string, CredibilityScore>>(() => {
    if (corpus.length === 0) return new Map();
    const clusters = clusterStories(corpus);
    const list = scoreCorpus(corpus, defaultFactors(), { clusters });
    return new Map(list.map((s) => [s.article.id, s]));
  }, [corpus]);

  const aggregated = useMemo<AggregatedEntity[]>(() => {
    const byKey = new Map<string, AggregatedEntity>();
    for (const article of corpus) {
      const ents = extracted[article.id];
      if (!ents) continue;
      const cred = scores.get(article.id)?.score ?? null;
      for (const e of ents) {
        const key = `${entityKey(e.entity)}::${e.type}`;
        if (!key.startsWith("::")) {
          const existing = byKey.get(key);
          const occ: Occurrence = {
            articleId: article.id,
            source: article.source,
            url: article.url,
            confidence: e.confidence,
            mention: e.mention || "",
            credibility: cred,
          };
          if (existing) {
            existing.occurrences.push(occ);
          } else {
            byKey.set(key, {
              entity: e.entity,
              type: e.type,
              occurrences: [occ],
              sourceCount: 0,
              bestConfidence: 0,
              bestCredibility: null,
            });
          }
        }
      }
    }

    const out = Array.from(byKey.values()).map((a) => {
      const creds = a.occurrences.map((o) => o.credibility).filter((c): c is number => c !== null);
      return {
        ...a,
        sourceCount: new Set(a.occurrences.map((o) => o.source)).size,
        // Max, not mean. Averaging two model-reported confidences produces a
        // third number no model ever asserted.
        bestConfidence: Math.max(...a.occurrences.map((o) => o.confidence)),
        bestCredibility: creds.length ? Math.max(...creds) : null,
      };
    });

    return out.sort(
      (x, y) =>
        y.sourceCount - x.sourceCount ||
        (y.bestCredibility ?? -1) - (x.bestCredibility ?? -1) ||
        y.bestConfidence - x.bestConfidence ||
        x.entity.localeCompare(y.entity),
    );
  }, [corpus, extracted, scores]);

  const types = useMemo(
    () => Array.from(new Set(aggregated.map((a) => a.type))).sort(),
    [aggregated],
  );
  const visible = typeFilter ? aggregated.filter((a) => a.type === typeFilter) : aggregated;
  const analysed = Object.keys(extracted).length;

  const runExtraction = async (article: Article) => {
    setBusyId(article.id);
    setExtractError("");
    try {
      const res: any = await aiExtractEntities({ data: { article } });
      setExtracted((prev) => ({ ...prev, [article.id]: res.entities ?? [] }));
      setModel(res.model);
    } catch (err: any) {
      setExtractError(err?.message ?? String(err));
    } finally {
      setBusyId(null);
    }
  };

  const handleSearch = () => {
    const v = searchVal.trim();
    if (!v) return;
    setActiveTarget(v);
    setTarget(v);
  };

  return (
    <AppShell>
      <PageHeader
        title="Entity Explorer"
        description="Entities extracted from live open-source reporting on the active subject, aggregated across sources and weighted by source credibility."
      />

      <Card className="mb-4">
        <CardContent className="p-4">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={searchVal}
              onChange={(e) => setSearchVal(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleSearch()}
              placeholder="Search target subject or entity..."
              className="h-11 pl-9 pr-24 text-base"
            />
            <Button
              size="sm"
              onClick={handleSearch}
              className="absolute right-1.5 top-1/2 -translate-y-1/2"
            >
              Search
            </Button>
          </div>
        </CardContent>
      </Card>

      {loadError && (
        <Card className="mb-4 border-console-red/30">
          <CardContent className="flex items-start gap-2 p-3">
            <AlertTriangle className="size-4 shrink-0 text-console-red" />
            <div className="font-mono text-[11px] text-console-red">
              <span className="font-bold">Collection failed.</span> No corpus was retrieved for this
              subject.
              <div className="pt-0.5 opacity-80">{loadError}</div>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
        {/* ── Aggregated entities ─────────────────────────────────────────── */}
        <div className="space-y-3">
          <Card>
            <CardContent className="p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Tags className="size-4 text-console-purple" />
                <h3 className="text-sm font-semibold">
                  Entities across {analysed} analysed article{analysed === 1 ? "" : "s"}
                </h3>
                {model && (
                  <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                    {model}
                  </span>
                )}
              </div>

              {types.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1">
                  <Badge
                    onClick={() => setTypeFilter(null)}
                    className={`cursor-pointer text-[10px] font-normal ${
                      typeFilter === null ? "" : "opacity-50"
                    }`}
                    variant="secondary"
                  >
                    all ({aggregated.length})
                  </Badge>
                  {types.map((t) => (
                    <Badge
                      key={t}
                      onClick={() => setTypeFilter(t === typeFilter ? null : t)}
                      className={`cursor-pointer text-[10px] font-normal ${TYPE_COLOURS[t] ?? TYPE_COLOURS.OTHER} ${
                        typeFilter === null || typeFilter === t ? "" : "opacity-40"
                      }`}
                    >
                      {t} ({aggregated.filter((a) => a.type === t).length})
                    </Badge>
                  ))}
                </div>
              )}

              {visible.length === 0 ? (
                <p className="mt-4 text-sm text-muted-foreground">
                  {analysed === 0
                    ? 'No article has been analysed yet. Use "Extract" on an article to the right — extraction is a model call, so it runs only when you ask for it.'
                    : "The model found no named entities in the analysed articles."}
                </p>
              ) : (
                <div className="mt-3 divide-y">
                  {visible.map((a) => {
                    const key = `${a.entity}::${a.type}`;
                    const open = openEntity === key;
                    const band =
                      a.bestCredibility === null ? "unknown" : bandFor(a.bestCredibility).tone;
                    return (
                      <div key={key} className="py-2">
                        <button
                          onClick={() => setOpenEntity(open ? null : key)}
                          className="flex w-full items-center gap-2 text-left"
                        >
                          {open ? (
                            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                          ) : (
                            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                          )}
                          <span className="min-w-0 flex-1 truncate text-sm font-medium">
                            {a.entity}
                          </span>
                          <Badge
                            className={`shrink-0 text-[10px] font-normal ${TYPE_COLOURS[a.type] ?? TYPE_COLOURS.OTHER}`}
                          >
                            {a.type}
                          </Badge>
                          <span
                            className="shrink-0 font-mono text-[10px] text-muted-foreground"
                            title="Distinct outlets in this corpus that named the entity."
                          >
                            {a.sourceCount} src
                          </span>
                          <span
                            className={`shrink-0 font-mono text-[10px] ${BAND_COLOURS[band]}`}
                            title={
                              a.bestCredibility === null
                                ? "No factor could be scored for any article naming this entity."
                                : "Highest Module 1 credibility among the articles naming this entity, using default factor weights."
                            }
                          >
                            {a.bestCredibility === null
                              ? "cred —"
                              : `cred ${a.bestCredibility.toFixed(2)}`}
                          </span>
                        </button>

                        {open && (
                          <div className="mt-2 space-y-1.5 pl-5">
                            {a.occurrences.map((o, i) => (
                              <div key={i} className="rounded border bg-muted/30 p-2 text-[11px]">
                                <div className="flex items-center gap-2">
                                  <span className="font-mono text-[10px] text-foreground">
                                    {o.source}
                                  </span>
                                  <span className="text-muted-foreground">
                                    model confidence {o.confidence.toFixed(2)}
                                  </span>
                                  {o.credibility !== null && (
                                    <span
                                      className={`ml-auto ${BAND_COLOURS[bandFor(o.credibility).tone]}`}
                                    >
                                      article cred {o.credibility.toFixed(2)}
                                    </span>
                                  )}
                                </div>
                                {o.mention && (
                                  <p className="mt-0.5 italic text-muted-foreground">
                                    "{o.mention}"
                                  </p>
                                )}
                                {o.url && (
                                  <a
                                    href={o.url}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="mt-0.5 inline-flex items-center gap-1 text-[10px] text-console-blue hover:underline"
                                  >
                                    Open source <ExternalLink className="size-2.5" />
                                  </a>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="flex items-start gap-2 p-3">
              <Info className="size-3.5 shrink-0 text-muted-foreground" />
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Confidence values are reported by the model per extraction and are shown unmodified
                — the aggregate row shows the highest observed value rather than a mean, because
                averaging two model-reported confidences produces a number no model asserted.
                Credibility is Module 1's score for the article, computed with default factor
                weights; retune them on the Source Credibility page.
              </p>
            </CardContent>
          </Card>
        </div>

        {/* ── Corpus ──────────────────────────────────────────────────────── */}
        <div className="space-y-3">
          <Card>
            <CardContent className="p-4">
              <h3 className="text-sm font-semibold">Corpus for "{target}"</h3>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {loading
                  ? "Collecting…"
                  : `${corpus.length} article${corpus.length === 1 ? "" : "s"} collected. Extraction is one model call each.`}
              </p>

              {extractError && (
                <div className="mt-2 flex items-start gap-2 rounded border border-console-red/30 bg-console-red/5 p-2">
                  <AlertTriangle className="size-3.5 shrink-0 text-console-red" />
                  <div className="font-mono text-[10px] leading-relaxed text-console-red">
                    <span className="font-bold">AI unavailable.</span> No entities were extracted.
                    <div className="pt-0.5 opacity-80">{extractError}</div>
                  </div>
                </div>
              )}

              <div className="mt-3 space-y-2">
                {loading && (
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" /> Collecting open sources…
                  </div>
                )}
                {!loading && corpus.length === 0 && !loadError && (
                  <p className="text-xs text-muted-foreground">
                    No articles were collected for this subject. Try a different search term.
                  </p>
                )}
                {corpus.map((a) => {
                  const done = Boolean(extracted[a.id]);
                  const score = scores.get(a.id);
                  return (
                    <div key={a.id} className="rounded-md border bg-card p-2.5">
                      <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                        <span className="font-mono">{a.source}</span>
                        {score?.score != null && (
                          <span className={`ml-auto ${BAND_COLOURS[bandFor(score.score).tone]}`}>
                            cred {score.score.toFixed(2)}
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 line-clamp-2 text-xs leading-snug">{a.title}</p>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busyId !== null || done}
                        onClick={() => runExtraction(a)}
                        className="mt-1.5 h-6 gap-1 text-[10px]"
                      >
                        {busyId === a.id ? (
                          <Loader2 className="size-2.5 animate-spin" />
                        ) : (
                          <Tags className="size-2.5" />
                        )}
                        {done ? `${extracted[a.id].length} extracted` : "Extract"}
                      </Button>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </AppShell>
  );
}
