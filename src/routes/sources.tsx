import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AppShell, PageHeader } from "@/components/app-shell";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import {
  Gauge,
  ChevronDown,
  ChevronRight,
  Loader2,
  AlertTriangle,
  RotateCcw,
  Save,
  Sparkles,
  Trash2,
  Info,
  X,
  Shield,
  Plus,
  Globe,
} from "lucide-react";
import { fetchNews } from "./news";
import { getActiveTarget } from "@/utils/active-target";
import {
  applyProfile,
  bandFor,
  builtinProfiles,
  defaultFactors,
  domainOf,
  loadCustomProfiles,
  saveCustomProfiles,
  scoreCorpus,
  loadActiveFactorConfig,
  saveActiveFactorConfig,
  loadCustomDomainOverrides,
  saveCustomDomainOverrides,
  reputationOf,
  type Article,
  type CredibilityFactor,
  type CredibilityScore,
  type WeightProfile,
  type DomainEntry,
  type SourceTier,
  type SourceType,
  TIER_SCORES,
} from "@/utils/credibility";
import {
  assessLanguageFor,
  assessmentSummary,
  type LanguageAssessment,
} from "@/utils/credibility-llm";
import {
  serverLoadProfiles,
  serverSaveProfiles,
  LEGACY_PROFILE_LOCALSTORAGE_KEY,
} from "@/utils/credibility-profiles";

export const Route = createFileRoute("/sources")({
  head: () => ({ meta: [{ title: "Source Credibility — Sentinel AI" }] }),
  component: SourcesPage,
});

const CARD = "bg-console-surface border-console-border";
const DIM = "text-console-label";
const MUTED = "text-console-muted";

const TONE: Record<string, string> = {
  high: "border-console-green/30 bg-console-green/10 text-console-green",
  medium: "border-console-amber/30 bg-console-amber/10 text-console-amber",
  low: "border-console-red/30 bg-console-red/10 text-console-red",
  unknown: "border-console-label/30 bg-console-label/10 text-console-muted",
};
const BAR: Record<string, string> = {
  high: "bg-console-green",
  medium: "bg-console-amber",
  low: "bg-console-red",
  unknown: "bg-console-label",
};

function SourcesPage() {
  // Empty on both server and first client render — getActiveTarget() reads
  // localStorage, unavailable during SSR. The mount+listener effect below
  // sets the real value client-side and keeps it in sync with the top-nav
  // search bar, matching the pattern used on the other routes that share
  // this global target.
  const [target, setTarget] = useState("");
  const [corpus, setCorpus] = useState<Article[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  const [factors, setFactors] = useState<CredibilityFactor[]>(() => defaultFactors());
  const [profiles, setProfiles] = useState<WeightProfile[]>(() => builtinProfiles());
  const [activeProfileId, setActiveProfileId] = useState("default");
  const [keywordsRaise, setKeywordsRaise] = useState<string[]>([]);
  const [keywordsLower, setKeywordsLower] = useState<string[]>([]);
  const [kwDraft, setKwDraft] = useState("");
  const [kwSide, setKwSide] = useState<"raise" | "lower">("lower");
  const [expanded, setExpanded] = useState<string | null>(null);

  // LLM tone assessment state
  const [languageAssessments, setLanguageAssessments] = useState<
    Record<string, LanguageAssessment>
  >({});
  const [assessingTone, setAssessingTone] = useState(false);
  const [toneSummaryText, setToneSummaryText] = useState("");

  // Domain overrides state
  const [domainOverrides, setDomainOverrides] = useState<Record<string, DomainEntry>>({});
  const [newDomain, setNewDomain] = useState("");
  const [newDomainTier, setNewDomainTier] = useState<SourceTier>("SPECIALIST");
  const [newDomainType, setNewDomainType] = useState<SourceType>("specialist");

  // Load persistent storage on mount
  useEffect(() => {
    (async () => {
      // One-time migration: if the analyst had custom profiles in localStorage
      // from before the server-side store existed, migrate them now.
      let migrationPayload: WeightProfile[] = [];
      try {
        const legacy = typeof window !== "undefined"
          ? window.localStorage.getItem(LEGACY_PROFILE_LOCALSTORAGE_KEY)
          : null;
        if (legacy) {
          const parsed = JSON.parse(legacy);
          migrationPayload = Array.isArray(parsed) ? parsed.filter((p: WeightProfile) => p && !p.builtin) : [];
        }
      } catch {
        migrationPayload = [];
      }

      try {
        const result = await serverLoadProfiles({
          data: migrationPayload.length > 0 ? { migrateFromLocalStorage: migrationPayload } : {},
        }) as unknown as { profiles: WeightProfile[] };
        const serverCustom = result?.profiles ?? [];
        setProfiles([...builtinProfiles(), ...serverCustom]);
        // Clear the legacy key after a successful migration
        if (migrationPayload.length > 0 && typeof window !== "undefined") {
          window.localStorage.removeItem(LEGACY_PROFILE_LOCALSTORAGE_KEY);
        }
      } catch {
        // Server unreachable on first render (SSR). Fall back to localStorage.
        setProfiles([...builtinProfiles(), ...loadCustomProfiles()]);
      }

      setDomainOverrides(loadCustomDomainOverrides());

      const savedConfig = loadActiveFactorConfig();
      if (savedConfig) {
        setActiveProfileId(savedConfig.activeProfileId);
        setKeywordsRaise(savedConfig.customKeywords.raise || []);
        setKeywordsLower(savedConfig.customKeywords.lower || []);
        setFactors((prev) =>
          prev.map((f) => {
            const s = savedConfig.settings[f.id];
            return s ? { ...f, weight: s.weight, enabled: s.enabled } : f;
          }),
        );
      }
    })();
  }, []);

  // Save active factor configuration whenever it changes
  useEffect(() => {
    saveActiveFactorConfig({
      activeProfileId,
      settings: Object.fromEntries(
        factors.map((f) => [f.id, { weight: f.weight, enabled: f.enabled }]),
      ),
      customKeywords: { raise: keywordsRaise, lower: keywordsLower },
    });
  }, [factors, activeProfileId, keywordsRaise, keywordsLower]);

  useEffect(() => {
    const initial = getActiveTarget();
    setTarget(initial);

    // Without this, changing the target via the top-nav search bar while
    // already on this page did nothing until navigating away and back.
    const handleTargetChange = (e: any) => {
      if (e.detail) setTarget(e.detail);
    };
    window.addEventListener("sentinel_target_changed", handleTargetChange);
    return () => window.removeEventListener("sentinel_target_changed", handleTargetChange);
  }, []);

  // Ingest the live corpus. No seed data — an empty feed shows as empty.
  useEffect(() => {
    // Skip the empty placeholder — the mount-sync effect above fills in the
    // real target a moment later, which re-triggers this effect via [target].
    if (!target) return;
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError("");
      try {
        const res: any = await fetchNews({ data: { query: target } });
        if (cancelled) return;
        const mapped: Article[] = (res?.stories ?? [])
          .map((s: any, i: number) => ({
            id: String(s.primaryLink || s.url || i),
            title: s.primaryTitle || "",
            source: s.primarySource || "",
            /*
             * `s.url` is the PUBLISHER's URL, not the feed link — Module 1 reads
             * its domain from this field.
             *
             * The order here used to be `s.primaryLink || s.url`, and on a
             * queried corpus every primaryLink is a news.google.com redirect, so
             * domainOf() returned the aggregator for all 35 articles and
             * domain_tier scored the same value every time. Securelist, Reuters
             * and 9to5Google were all rated identically Low.
             *
             * An empty string when no publisher was identified: credibility.ts
             * then skips domain_tier with a stated reason, which is the correct
             * outcome and is what the engine is built to do.
             */
            url: s.url || "",
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

  // Live recompute with custom keywords & language assessments
  const scored = useMemo(
    () =>
      scoreCorpus(corpus, factors, {
        customKeywords: { raise: keywordsRaise, lower: keywordsLower },
        language: languageAssessments,
      }),
    [corpus, factors, keywordsRaise, keywordsLower, languageAssessments],
  );

  const setWeight = useCallback((id: string, weight: number) => {
    setFactors((prev) => prev.map((f) => (f.id === id ? { ...f, weight } : f)));
  }, []);

  const toggleFactor = useCallback((id: string, enabled: boolean) => {
    setFactors((prev) => prev.map((f) => (f.id === id ? { ...f, enabled } : f)));
  }, []);

  const handleRunToneAssessment = async () => {
    if (corpus.length === 0) {
      toast.error("No articles available in the current corpus to assess.");
      return;
    }
    setAssessingTone(true);
    toast.info(`Evaluating linguistic markers for ${corpus.length} article(s)...`);
    try {
      const batch = await assessLanguageFor(corpus);
      setLanguageAssessments(batch.assessments);
      const summary = assessmentSummary(batch, corpus.length);
      setToneSummaryText(summary);
      if (batch.failures.length > 0) {
        toast.warning(summary);
      } else {
        toast.success(summary);
      }
      // Ensure linguistic_markers factor is enabled
      setFactors((prev) =>
        prev.map((f) => (f.id === "linguistic_markers" ? { ...f, enabled: true } : f)),
      );
    } catch (err: any) {
      toast.error(`Tone assessment failed: ${err?.message ?? String(err)}`);
    } finally {
      setAssessingTone(false);
    }
  };

  const handleAddDomainOverride = () => {
    if (!newDomain.trim()) return;
    const clean = newDomain
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "");
    const updated = {
      ...domainOverrides,
      [clean]: { tier: newDomainTier, type: newDomainType },
    };
    setDomainOverrides(updated);
    saveCustomDomainOverrides(updated);
    setNewDomain("");
    toast.success(`Domain reputation override added for ${clean}.`);
  };

  const handleDeleteDomainOverride = (domainKey: string) => {
    const updated = { ...domainOverrides };
    delete updated[domainKey];
    setDomainOverrides(updated);
    saveCustomDomainOverrides(updated);
    toast.success(`Domain override for ${domainKey} removed.`);
  };

  const selectProfile = (id: string) => {
    const p = profiles.find((x) => x.id === id);
    if (!p) return;
    setActiveProfileId(id);
    setFactors((prev) => applyProfile(prev, p));
    setKeywordsRaise(p.customKeywords.raise);
    setKeywordsLower(p.customKeywords.lower);
  };

  const saveAsProfile = () => {
    const name = prompt("Profile name");
    if (!name?.trim()) return;
    const next: WeightProfile = {
      id: `custom-${name.trim().toLowerCase().replace(/\s+/g, "-")}`,
      name: name.trim(),
      settings: Object.fromEntries(
        factors.map((f) => [f.id, { weight: f.weight, enabled: f.enabled }]),
      ),
      customKeywords: { raise: keywordsRaise, lower: keywordsLower },
    };
    const custom = [...profiles.filter((p) => !p.builtin && p.id !== next.id), next];
    setProfiles([...builtinProfiles(), ...custom]);
    void serverSaveProfiles({ data: { profiles: custom } }).catch(() => {
      // Server unavailable — fall back to localStorage so the profile isn't lost
      saveCustomProfiles(custom);
    });
    setActiveProfileId(next.id);
  };

  const deleteProfile = (id: string) => {
    const custom = profiles.filter((p) => !p.builtin && p.id !== id);
    setProfiles([...builtinProfiles(), ...custom]);
    void serverSaveProfiles({ data: { profiles: custom } }).catch(() => {
      saveCustomProfiles(custom);
    });
    if (activeProfileId === id) selectProfile("default");
  };

  const addKeyword = () => {
    const k = kwDraft.trim().toLowerCase();
    if (!k) return;
    if (kwSide === "raise") setKeywordsRaise((p) => Array.from(new Set([...p, k])));
    else setKeywordsLower((p) => Array.from(new Set([...p, k])));
    setKwDraft("");
  };

  const disabled = factors.filter((f) => !f.enabled);
  const activeProfile = profiles.find((p) => p.id === activeProfileId);

  return (
    <AppShell>
      <PageHeader
        title="Source Credibility"
        description="PS-18 Module 1 — credibility scored on analyst-defined factors. Every score carries a per-factor breakdown; nothing is computed by an LLM in this view."
      />

      <div className="grid gap-4 p-6 lg:grid-cols-[360px_1fr]">
        {/* ── Left: factor controls ─────────────────────────────────── */}
        <div className="space-y-3">
          <Card className={`${CARD} space-y-3 p-4`}>
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-2 font-mono text-xs font-bold text-console-text">
                <Gauge className="size-4 text-console-cyan" /> Factors
              </span>
              <span className={`font-mono text-[10px] ${DIM}`}>
                {factors.filter((f) => f.enabled).length}/{factors.length} on
              </span>
            </div>
            <p className={`font-mono text-[9px] leading-relaxed ${DIM}`}>
              Weights are normalised across whichever factors are enabled, so they always sum to 1.
              Scores recompute as you drag — there is no apply step.
            </p>

            {factors.map((f) => (
              <div key={f.id} className="space-y-1 border-t border-console-border pt-2">
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={`font-mono text-[10px] ${f.enabled ? "text-console-text" : DIM}`}
                    title={f.description}
                  >
                    {f.name}
                    {f.requiresLlm && <Sparkles className="ml-1 inline size-2.5 text-console-purple" />}
                    <Info className="ml-1 inline size-2.5 opacity-40" />
                  </span>
                  <div className="flex items-center gap-2">
                    <span className={`font-mono text-[10px] ${f.enabled ? MUTED : DIM}`}>
                      {f.weight.toFixed(2)}
                    </span>
                    <Switch
                      checked={f.enabled}
                      onCheckedChange={(v) => toggleFactor(f.id, v)}
                      aria-label={`Enable ${f.name}`}
                    />
                  </div>
                </div>
                <Slider
                  value={[f.weight * 100]}
                  max={100}
                  step={1}
                  disabled={!f.enabled}
                  onValueChange={([v]) => setWeight(f.id, v / 100)}
                />
                <p className={`font-mono text-[9px] leading-relaxed ${DIM}`}>{f.description}</p>
                {f.requiresLlm && (
                  <div className="space-y-1.5 pt-1">
                    <Button
                      size="sm"
                      onClick={handleRunToneAssessment}
                      disabled={assessingTone}
                      className="h-7 w-full rounded bg-console-purple font-mono text-[9px] font-bold text-console-text hover:bg-console-purple/90 disabled:opacity-50"
                    >
                      {assessingTone ? (
                        <>
                          <Loader2 className="mr-1 size-3 animate-spin" /> Evaluating Tone with LLM…
                        </>
                      ) : (
                        <>
                          <Sparkles className="mr-1 size-3" /> Analyze Tone with AI
                        </>
                      )}
                    </Button>
                    {toneSummaryText && (
                      <p className="font-mono text-[9px] leading-relaxed text-[#A78BFA]">
                        {toneSummaryText}
                      </p>
                    )}
                  </div>
                )}
              </div>
            ))}

            <div className="flex gap-2 pt-1">
              <Button
                size="sm"
                onClick={() => {
                  setFactors(defaultFactors());
                  setActiveProfileId("default");
                }}
                className="h-7 flex-1 rounded bg-console-elevated font-mono text-[9px] text-console-muted hover:bg-console-border"
              >
                <RotateCcw className="mr-1 size-3" /> Reset
              </Button>
              <Button
                size="sm"
                onClick={saveAsProfile}
                className="h-7 flex-1 rounded bg-console-cyan font-mono text-[9px] font-bold text-console-accent-foreground hover:bg-console-cyan/90"
              >
                <Save className="mr-1 size-3" /> Save as profile
              </Button>
            </div>
          </Card>

          {/* Domain Reputation Overrides */}
          <Card className={`${CARD} space-y-3 p-4`}>
            <span className="flex items-center gap-2 font-mono text-xs font-bold text-console-text">
              <Globe className="size-4 text-console-cyan" /> Custom Domain Ratings
            </span>
            <p className={`font-mono text-[9px] leading-relaxed ${DIM}`}>
              Override editorial tiers for specific news domains or add regional sources to the
              reputation table.
            </p>
            <div className="space-y-1.5">
              <div className="flex gap-1">
                <Input
                  value={newDomain}
                  onChange={(e) => setNewDomain(e.target.value)}
                  placeholder="domain.com (e.g. defensenews.in)"
                  className="h-7 border-console-border bg-console-deep font-mono text-[10px] text-console-text"
                />
                <select
                  value={newDomainTier}
                  onChange={(e) => setNewDomainTier(e.target.value as SourceTier)}
                  className="h-7 rounded border border-console-border bg-console-deep px-1 font-mono text-[9px] text-console-text"
                >
                  <option value="TIER_1">Tier 1 (0.90)</option>
                  <option value="SPECIALIST">Specialist (0.85)</option>
                  <option value="TIER_2">Tier 2 (0.70)</option>
                  <option value="TIER_3">Tier 3 (0.50)</option>
                  <option value="LOW">Low (0.25)</option>
                </select>
                <Button
                  size="sm"
                  onClick={handleAddDomainOverride}
                  className="h-7 rounded bg-console-cyan px-2 font-mono text-[9px] font-bold text-console-accent-foreground"
                >
                  <Plus className="size-3" />
                </Button>
              </div>
            </div>

            {Object.keys(domainOverrides).length > 0 && (
              <div className="space-y-1 border-t border-console-border pt-2">
                {Object.entries(domainOverrides).map(([domainKey, entry]) => (
                  <div
                    key={domainKey}
                    className="flex items-center justify-between gap-1 rounded bg-console-deep p-1.5"
                  >
                    <div className="font-mono text-[9px] text-console-text">
                      <span className="font-bold">{domainKey}</span>{" "}
                      <span className={DIM}>
                        · {entry.tier} ({TIER_SCORES[entry.tier].toFixed(2)})
                      </span>
                    </div>
                    <Button
                      size="sm"
                      onClick={() => handleDeleteDomainOverride(domainKey)}
                      className="h-5 w-5 rounded p-0 text-console-red hover:bg-console-border"
                      aria-label={`Remove override for ${domainKey}`}
                    >
                      <X className="size-3" />
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </Card>

          {/* Profiles */}
          <Card className={`${CARD} space-y-2 p-4`}>
            <span className="font-mono text-xs font-bold text-console-text">Weight profiles</span>
            {profiles.map((p) => (
              <div key={p.id} className="flex items-center gap-1">
                <button
                  onClick={() => selectProfile(p.id)}
                  className={`flex-1 rounded border p-2 text-left font-mono text-[10px] transition-colors ${
                    activeProfileId === p.id
                      ? "border-console-cyan bg-console-cyan/5 text-console-cyan"
                      : "border-console-border bg-console-deep text-console-text hover:border-console-cyan/50"
                  }`}
                >
                  {p.name}
                  {p.builtin && <span className={`ml-1 ${DIM}`}>· built-in</span>}
                </button>
                {!p.builtin && (
                  <Button
                    size="sm"
                    onClick={() => deleteProfile(p.id)}
                    className="h-7 w-7 rounded bg-console-elevated p-0 text-console-red hover:bg-console-border"
                    aria-label={`Delete ${p.name}`}
                  >
                    <Trash2 className="size-3" />
                  </Button>
                )}
              </div>
            ))}
          </Card>

          {/* Custom criterion */}
          <Card className={`${CARD} space-y-2 p-4`}>
            <span className="font-mono text-xs font-bold text-console-text">Custom criterion</span>
            <p className={`font-mono text-[9px] leading-relaxed ${DIM}`}>
              PS-18 asks for user-defined criteria. Define keywords that raise or lower the score.
              The factor stays skipped until at least one keyword exists.
            </p>
            <div className="flex gap-1">
              <select
                value={kwSide}
                onChange={(e) => setKwSide(e.target.value as "raise" | "lower")}
                className="h-7 rounded border border-console-border bg-console-deep px-1 font-mono text-[10px] text-console-text"
              >
                <option value="lower">Lower</option>
                <option value="raise">Raise</option>
              </select>
              <Input
                value={kwDraft}
                onChange={(e) => setKwDraft(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addKeyword()}
                placeholder="e.g. unconfirmed"
                className="h-7 border-console-border bg-console-deep font-mono text-[10px] text-console-text"
              />
              <Button
                size="sm"
                onClick={addKeyword}
                className="h-7 rounded bg-console-cyan px-2 font-mono text-[9px] font-bold text-console-accent-foreground"
              >
                Add
              </Button>
            </div>
            {(["raise", "lower"] as const).map((side) => {
              const list = side === "raise" ? keywordsRaise : keywordsLower;
              if (list.length === 0) return null;
              return (
                <div key={side} className="flex flex-wrap gap-1">
                  <span className={`font-mono text-[9px] ${DIM}`}>{side}:</span>
                  {list.map((k) => (
                    <Badge
                      key={k}
                      className={`gap-1 text-[9px] ${side === "raise" ? TONE.high : TONE.low}`}
                    >
                      {k}
                      <button
                        onClick={() =>
                          side === "raise"
                            ? setKeywordsRaise((p) => p.filter((x) => x !== k))
                            : setKeywordsLower((p) => p.filter((x) => x !== k))
                        }
                        aria-label={`Remove ${k}`}
                      >
                        <X className="size-2.5" />
                      </button>
                    </Badge>
                  ))}
                </div>
              );
            })}
          </Card>
        </div>

        {/* ── Right: ranked corpus ──────────────────────────────────── */}
        <div className="space-y-3">
          {disabled.length > 0 && (
            <Card className={`${CARD} flex items-start gap-2 p-3`}>
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-console-amber" />
              <span className="font-mono text-[10px] leading-relaxed text-console-amber">
                <span className="font-bold">Partial scoring.</span> {disabled.length} factor
                {disabled.length === 1 ? " is" : "s are"} disabled (
                {disabled.map((f) => f.name).join(", ")}). Scores below are computed from the
                remaining factors only.
              </span>
            </Card>
          )}

          {loading && (
            <Card className={`${CARD} flex items-center gap-2 p-4 font-mono text-xs ${MUTED}`}>
              <Loader2 className="size-4 animate-spin" /> Ingesting live corpus…
            </Card>
          )}

          {loadError && (
            <Card className={`${CARD} p-4`}>
              <div className="flex items-start gap-2">
                <AlertTriangle className="size-4 shrink-0 text-console-red" />
                <div className="font-mono text-[11px] text-console-red">
                  Collection failed — no articles to score.
                  <div className={`pt-1 ${DIM}`}>{loadError}</div>
                </div>
              </div>
            </Card>
          )}

          {!loading && !loadError && scored.length === 0 && (
            <Card className={`${CARD} space-y-1 p-6 text-center`}>
              <div className="font-mono text-xs text-console-text">No articles ingested</div>
              <div className={`font-mono text-[10px] ${MUTED}`}>
                The collectors returned nothing for the active target, so there is nothing to score.
                This is an empty corpus, not a failure.
              </div>
            </Card>
          )}

          {scored.length > 0 && (
            <div className={`font-mono text-[10px] ${DIM}`}>
              {scored.length} articles · profile: {activeProfile?.name ?? "custom"}
            </div>
          )}

          {scored.map((s: CredibilityScore) => {
            const band = bandFor(s.score);
            const open = expanded === s.article.id;
            const domain = domainOf(s.article.url) || s.article.source;
            return (
              <Card key={s.article.id} className={`${CARD} p-3`}>
                <button
                  onClick={() => setExpanded(open ? null : s.article.id)}
                  className="flex w-full items-start gap-3 text-left"
                >
                  {open ? (
                    <ChevronDown className={`mt-0.5 size-4 shrink-0 ${DIM}`} />
                  ) : (
                    <ChevronRight className={`mt-0.5 size-4 shrink-0 ${DIM}`} />
                  )}
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="font-mono text-[11px] text-console-text">{s.article.title}</div>
                    <div className={`font-mono text-[9px] ${DIM}`}>{domain}</div>
                    <p className={`font-mono text-[9px] leading-relaxed ${MUTED}`}>
                      {s.explanation}
                    </p>
                  </div>
                  <div className="flex shrink-0 flex-col items-end gap-1">
                    <Badge className={`text-[10px] ${TONE[band.tone]}`}>
                      {s.score === null ? "—" : s.score.toFixed(2)} {band.label}
                    </Badge>
                    <div className="h-1 w-20 overflow-hidden rounded bg-console-deep">
                      <div
                        className={`h-full ${BAR[band.tone]}`}
                        style={{ width: `${Math.round((s.score ?? 0) * 100)}%` }}
                      />
                    </div>
                    <span className={`font-mono text-[9px] ${DIM}`}>
                      conf {s.confidence.toFixed(2)}
                    </span>
                  </div>
                </button>

                {open && (
                  <div className="mt-3 space-y-2 border-t border-console-border pt-3">
                    <div
                      className={`font-mono text-[9px] font-bold uppercase tracking-wider ${DIM}`}
                    >
                      Contributing factors
                    </div>
                    {s.breakdown.map((b) => (
                      <div key={b.id} className="space-y-0.5 rounded bg-console-deep p-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono text-[10px] text-console-text">{b.name}</span>
                          <span className={`font-mono text-[9px] ${MUTED}`}>
                            raw {b.rawScore.toFixed(2)} × weight {b.weight.toFixed(2)} ={" "}
                            <span className="font-bold text-console-cyan">
                              {b.contribution.toFixed(3)}
                            </span>
                          </span>
                        </div>
                        <p className={`font-mono text-[9px] leading-relaxed ${MUTED}`}>
                          {b.evidence}
                        </p>
                      </div>
                    ))}

                    {s.skipped.length > 0 && (
                      <>
                        <div
                          className={`pt-1 font-mono text-[9px] font-bold uppercase tracking-wider ${DIM}`}
                        >
                          Skipped — excluded from the score, not counted as zero
                        </div>
                        {s.skipped.map((sk) => (
                          <div key={sk.id} className="flex items-start justify-between gap-2 px-2">
                            <span className={`font-mono text-[9px] ${DIM}`}>{sk.name}</span>
                            <span className={`font-mono text-[9px] ${MUTED}`}>{sk.reason}</span>
                          </div>
                        ))}
                      </>
                    )}

                    {s.article.url && (
                      <a
                        href={s.article.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-block pt-1 font-mono text-[9px] text-console-blue hover:underline"
                      >
                        Open source article →
                      </a>
                    )}
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
