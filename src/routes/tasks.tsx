import { createFileRoute, Link } from "@tanstack/react-router";
import { AppShell, PageHeader } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useState } from "react";
import { toast } from "sonner";
import { llmAnalyseContent, llmExtractEntities } from "@/utils/llm";
import {
  DOMAIN_REPUTATION,
  TIER_SCORES,
  bandFor,
  defaultFactors,
  domainOf,
  reputationOf,
  scoreArticle,
  type Article,
} from "@/utils/credibility";
import {
  ListChecks,
  Shield,
  CheckCircle2,
  Cpu,
  Search,
  Eye,
  AlertTriangle,
  Play,
  FileText,
  UserSearch,
  Terminal,
  RefreshCw,
} from "lucide-react";

export const Route = createFileRoute("/tasks")({
  head: () => ({ meta: [{ title: "PS18 Verification Console — Sentinel AI" }] }),
  component: TasksPage,
});

function TasksPage() {
  const [activeTab, setActiveTab] = useState("matrix");
  const [selfTestLog, setSelfTestLog] = useState<string[]>([]);
  const [testing, setTesting] = useState(false);

  // Module 1 state
  const [mod1Source, setMod1Source] = useState("TASS News");
  const [mod1Result, setMod1Result] = useState<any>(null);

  // Module 2 state
  const [mod2Text, setMod2Text] = useState(
    "Security breach detected near Moscow spaceport nodes by Vector-17 cyber operative cluster. Technical reports suggest malware coordinates linked to C2 blocklists.",
  );
  const [mod2Result, setMod2Result] = useState<any>(null);

  // Module 3 state
  const [mod3Handle, setMod3Handle] = useState("@disinfo_pulse");
  const [mod3Result, setMod3Result] = useState<any>(null);

  // Module 4 state
  const [mod4FileName, setMod4FileName] = useState("capture_drone_exif.jpg");
  const [mod4Result, setMod4Result] = useState<any>(null);

  /**
   * Capability probe.
   *
   * This previously printed a fixed sequence of "[OK] ... NOMINAL" lines from a
   * setTimeout chain and concluded "100% compliant with PS18 specs". It executed
   * nothing and measured nothing. On a compliance console for a defence
   * evaluation, that is the single most damaging thing in the codebase.
   *
   * It now actually exercises what exists and reports what does not.
   */
  const runSelfTest = async () => {
    setTesting(true);
    const log: string[] = [
      "[SYS] Probing implemented capability. No result is asserted without executing it.",
    ];
    setSelfTestLog([...log]);
    const push = (line: string) => {
      log.push(line);
      setSelfTestLog([...log]);
    };

    // Module 1 — deterministic, runs locally.
    push("[SYS] Module 1: source credibility...");
    try {
      const probe = {
        id: "probe",
        title: "Probe article for capability check",
        source: "reuters.com",
        url: "https://www.reuters.com/probe",
        pubDate: new Date().toISOString(),
      };
      const factors = defaultFactors();
      const scored = scoreArticle(probe, [probe], factors);
      const total = scored.breakdown.length + scored.skipped.length;
      push(
        `[PASS] Module 1 executed: ${scored.breakdown.length}/${total} factors computed, score ${scored.score?.toFixed(2) ?? "n/a"}. Weighting is analyst-configurable on /sources.`,
      );
    } catch (e: any) {
      push(`[FAIL] Module 1 threw: ${e?.message ?? e}`);
    }

    // Module 2 — requires a live model, so this is a real network call.
    push("[SYS] Module 2: content analysis (live model call)...");
    try {
      const res: any = await llmExtractEntities({
        data: { text: "The DRDO conducted a test off the Odisha coast on Tuesday." },
      });
      push(
        `[PASS] Module 2 executed: ${res.entities?.length ?? 0} entities extracted by ${res.model}.`,
      );
    } catch (e: any) {
      push(`[FAIL] Module 2 unavailable: ${e?.message ?? e}`);
    }

    // These two lines said "[NOT IMPLEMENTED]" long after both modules were
    // built. That understated the system as badly as the all-green matrix
    // overstated it, and the two contradicted each other on the same page.
    push(
      "[PARTIAL] Module 3: social media analysis. Bluesky Jetstream firehose and public AppView, Mastodon hashtag timelines, Telegram channel previews and CIB signal detection all run. Reddit requires OAuth credentials. Instagram, Facebook and X are not collected — platform terms and pricing make broad collection unavailable, which is a constraint rather than a gap.",
    );
    push(
      "[PARTIAL] Module 4: media analysis. C2PA Content Credentials, EXIF, OCR across nine Indic scripts, perceptual hashing, keyframe sampling and scene-cut detection all run in the browser. No deepfake classifier, object detector, face matching or audio transcription — those gaps are declared on /images with the reason for each.",
    );
    push(
      "[PARTIAL] Module 5: report generation runs on the configured open-weight LLM. The GIS map renders CARTO raster tiles; USGS epicentres are exact coordinates, while GDELT records carry the publisher country rather than an event location and are drawn as country-precision uncertainty circles.",
    );
    push(
      "[SYS] Probe complete. Modules 1 and 2 were executed above and their real results are shown. Modules 3, 4 and 5 are implemented with stated limits and are not exercised by this probe — drive them from /social, /images and /reports. This is a prototype, not an accredited system.",
    );

    setTesting(false);
    toast.success("Capability probe complete — see log for what actually ran.");
  };

  /**
   * Module 1 evaluation — PUBLISHER-LEVEL ONLY, and labelled as such.
   *
   * Two rounds of invention have been removed from this panel. The bias
   * coefficient was once a hardcoded ternary: any source string containing
   * "tass" or "rt" scored 85 and everything else 15, so "Bharti Airtel" scored
   * as state media because it contains "rt". That was replaced by a call into
   * the real engine — which then introduced a subtler version of the same
   * problem, because the engine needs an article and this panel has only a name:
   *
   *   - The probe carried a SYNTHETIC BODY ("Sample text for X evaluation.
   *     Outbound primary citation link: https://cisa.gov/resources."), so the
   *     citation-depth factor scored a hardcoded cisa.gov link that had nothing
   *     to do with the publisher being evaluated. Every source scored the same
   *     on it.
   *   - `pubDate` was stamped to now, so recency scored a perfect 1.0 for a
   *     publication event that never happened.
   *   - The corpus was the probe itself, so corroboration measured "0 other
   *     sources" — a property of the one-item corpus, not of the publisher.
   *   - The composite then fell back to `50` and the reputation to `0.5` when
   *     nothing could be computed, which credibility.ts forbids in as many
   *     words: a default is an invented measurement.
   *
   * What is genuinely knowable from a bare source name is the PUBLISHER's tier,
   * so that is the only factor run. The rest are not passed at all, and the
   * panel says why and points at /sources, where Module 1 scores real articles
   * against a real collected corpus.
   */
  const evaluateSource = () => {
    // An empty box previously scored as "Publisher tier score (): 50/100
    // (Moderate)" — a rating for a publisher the analyst never named.
    if (!mod1Source.trim()) {
      setMod1Result(null);
      toast.error("Enter a news source or domain to evaluate.");
      return;
    }
    const domain = domainOf(mod1Source) || mod1Source.trim().toLowerCase();
    const entry = reputationOf(domain);

    // No body and no pubDate. The engine already treats both as "cannot
    // compute" and skips the dependent factors with a stated reason, which is
    // the correct outcome — supplying filler would manufacture the measurement.
    const probeArticle: Article = {
      id: "task-eval",
      title: `Source evaluation for ${mod1Source}`,
      source: mod1Source,
      url: domain.includes(".") ? `https://${domain}` : `https://${domain}.com`,
      pubDate: "",
      body: "",
    };

    // Publisher tier only. Corroboration and source diversity are corpus
    // properties and this "corpus" is one synthetic probe, so including them
    // would report the shape of the probe as a finding about the source.
    const factors = defaultFactors().filter((f) => f.id === "domain_tier");
    const result = scoreArticle(probeArticle, [probeArticle], factors);
    const band = bandFor(result.score);

    setMod1Result({
      unrated: !entry,
      domain: domain || mod1Source,
      tier: entry?.tier ?? "UNRATED",
      // null, not 0.5. An unlisted domain has no reputation value; the engine
      // still scores it as neutral-unrated through domain_tier below, and that
      // score carries its own reduced confidence.
      reputation: entry ? TIER_SCORES[entry.tier] : null,
      // null, not 50. "Unscored" is a real outcome and bandFor renders it.
      score: result.score !== null ? Math.round(result.score * 100) : null,
      confidence: result.confidence,
      breakdown: result.breakdown,
      skipped: result.skipped,
      explanation: result.explanation,
      rating: band.label,
    });
    toast.success("Publisher tier evaluated. Full article scoring runs on /sources.");
  };

  // Module 2 — content analysis via the configured LLM
  const evaluateModule2 = async () => {
    toast.info("Executing NLP analysis...");
    try {
      const [analysisRes, nerRes] = await Promise.all([
        llmAnalyseContent({ data: { text: mod2Text } }),
        llmExtractEntities({ data: { text: mod2Text } }),
      ]);

      // Every field now comes from the model. The previous fallbacks supplied
      // "Vector-17 / Moscow / Cluster #42" whenever extraction returned nothing,
      // so an empty result was indistinguishable from a confident one.
      setMod2Result({
        ner: nerRes.entities ?? [],
        topic: analysisRes.topic,
        sentiment: analysisRes.sentiment,
        threatLevel: analysisRes.threatLevel,
        summary: analysisRes.summary,
        keywords: analysisRes.keywords ?? [],
        model: analysisRes.model,
        error: "",
      });
      toast.success("Module 2 analysis complete.");
    } catch (e: any) {
      setMod2Result({ error: e?.message ?? String(e) });
      toast.error("AI unavailable — Module 2 analysis failed.");
    }
  };

  // Modules 3 and 4 are NOT implemented.
  //
  // Module 3 previously returned a bot likelihood of 88 or 24 depending on
  // whether the handle contained "bot"/"disinfo", an influencer score derived
  // from the LENGTH of the handle string, and a hardcoded "+124% weekly"
  // growth figure.
  //
  // Module 4 returned fixed OCR text, fixed EXIF, a fixed "12% likelihood of AI
  // alteration" and a fixed object list — without reading any image at all.
  //
  // Both are deliberately left unimplemented rather than restored in any form:
  // honest absence is defensible at evaluation, invented forensics is not.

  return (
    <AppShell>
      <PageHeader
        title="PS18 Challenge Compliance Console"
        description="Verify compliance matrix for the IAF PS18 challenge: AI Based OSINT Analysis and monitoring system and social media stacks."
      />

      <div className="grid gap-4 lg:grid-cols-[250px_1fr] font-mono text-xs text-console-muted">
        {/* Left Side Tab Navigation */}
        <div className="space-y-1.5">
          <button
            onClick={() => setActiveTab("matrix")}
            className={`w-full text-left px-3 py-2 border rounded text-[10px] uppercase font-bold transition-all ${activeTab === "matrix" ? "border-console-blue bg-console-blue/10 text-console-text" : "border-console-border/40 bg-console-surface hover:bg-console-elevated"}`}
          >
            Compliance Matrix
          </button>
          <button
            onClick={() => setActiveTab("mod1")}
            className={`w-full text-left px-3 py-2 border rounded text-[10px] uppercase font-bold transition-all ${activeTab === "mod1" ? "border-console-blue bg-console-blue/10 text-console-text" : "border-console-border/40 bg-console-surface hover:bg-console-elevated"}`}
          >
            M1: Source Credibility
          </button>
          <button
            onClick={() => setActiveTab("mod2")}
            className={`w-full text-left px-3 py-2 border rounded text-[10px] uppercase font-bold transition-all ${activeTab === "mod2" ? "border-console-blue bg-console-blue/10 text-console-text" : "border-console-border/40 bg-console-surface hover:bg-console-elevated"}`}
          >
            M2: Content Analysis
          </button>
          <button
            onClick={() => setActiveTab("mod3")}
            className={`w-full text-left px-3 py-2 border rounded text-[10px] uppercase font-bold transition-all ${activeTab === "mod3" ? "border-console-blue bg-console-blue/10 text-console-text" : "border-console-border/40 bg-console-surface hover:bg-console-elevated"}`}
          >
            M3: Social Intelligence
          </button>
          <button
            onClick={() => setActiveTab("mod4")}
            className={`w-full text-left px-3 py-2 border rounded text-[10px] uppercase font-bold transition-all ${activeTab === "mod4" ? "border-console-blue bg-console-blue/10 text-console-text" : "border-console-border/40 bg-console-surface hover:bg-console-elevated"}`}
          >
            M4: Image & Video
          </button>
        </div>

        {/* Right workspace panels */}
        <div className="space-y-4">
          {/* Tab 1: Compliance Matrix */}
          {activeTab === "matrix" && (
            <div className="space-y-4">
              <Card className="bg-console-surface border-console-border rounded relative overflow-hidden">
                <div className="absolute top-0 left-0 h-full w-0.5 bg-console-blue" />
                <CardHeader className="p-3 border-b border-console-border bg-console-deep/20 pb-2">
                  <CardTitle className="text-[10px] font-bold uppercase tracking-widest text-console-muted flex items-center gap-1.5">
                    <ListChecks className="size-4 text-console-blue" /> Verification Diagnostic Matrix
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-4 space-y-3">
                  {/*
                    Every row of this matrix carried a green "Nominal / Verified"
                    badge — including Modules 3 and 4, which the self-test on
                    THIS SAME PAGE reports as [NOT IMPLEMENTED], and whose own
                    tabs say "This module does not produce a result." A false
                    compliance claim on a compliance console, for a defence
                    evaluation, is the most expensive kind of overclaim in this
                    codebase.

                    Status is now stated per module and matches what the rest of
                    the system says about itself. `features` lists only what is
                    actually built: "Deepfake Likelihood" and "Object count" are
                    declared in imaging.ts NOT_IMPLEMENTED and are named here as
                    gaps rather than delivered features.
                  */}
                  {[
                    {
                      m: "Module 1",
                      name: "Source Credibility Check",
                      features:
                        "Seven PS-18 factors, analyst-weighted, per-factor evidence. Six deterministic, one model-backed and opt-in.",
                      state: "implemented" as const,
                      note: "Weight profiles are per-browser (localStorage), not per-user and not audited.",
                    },
                    {
                      m: "Module 2",
                      name: "Open Source Content Analysis",
                      features:
                        "TF-IDF clustering, entity extraction, summarisation, language detection, passive external recon.",
                      state: "implemented" as const,
                      note: "Model-backed steps require a configured provider; failures surface as errors.",
                    },
                    {
                      m: "Module 3",
                      name: "Social Media Analysis",
                      features:
                        "Bluesky firehose + AppView, Mastodon, Telegram previews, CIB signal detection.",
                      state: "partial" as const,
                      note: "Reddit needs OAuth credentials. Instagram, Facebook and X are not collected — the platform terms and pricing make it unavailable, not unimplemented.",
                    },
                    {
                      m: "Module 4",
                      name: "Images & Video Analysis",
                      features:
                        "C2PA Content Credentials, EXIF, OCR (9 Indic scripts), perceptual hashing, keyframes, scene cuts.",
                      state: "partial" as const,
                      note: "No deepfake classifier, no object detection, no face matching, no audio transcription — see the declared gaps on /images.",
                    },
                    {
                      m: "Module 5",
                      name: "Report and GIS Visualization",
                      features:
                        "Cited intelligence products with model provenance, PDF/Markdown export, Leaflet map with coordinate-precision rendering.",
                      state: "partial" as const,
                      note: "UCDP needs a token; GDELT gives publisher country, not event location. Both are reported rather than hidden.",
                    },
                  ].map((item, idx) => (
                    <div
                      key={idx}
                      className="flex flex-wrap items-start justify-between gap-2 border-b border-console-border/30 pb-2 text-[10px]"
                    >
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <div className="font-bold text-console-text">
                          {item.m} · {item.name}
                        </div>
                        <div className="text-[9px] text-console-muted/60">{item.features}</div>
                        <div className="text-[9px] italic text-console-label">{item.note}</div>
                      </div>
                      <Badge
                        variant="outline"
                        className={`flex h-5 items-center gap-1 rounded-none text-[8px] font-bold uppercase ${
                          item.state === "implemented"
                            ? "border-green-500/20 bg-green-500/5 text-green-500"
                            : "border-amber-500/20 bg-amber-500/5 text-amber-500"
                        }`}
                      >
                        {item.state === "implemented" ? (
                          <CheckCircle2 className="size-3" />
                        ) : (
                          <AlertTriangle className="size-3" />
                        )}
                        {item.state === "implemented" ? "Implemented" : "Partial — see note"}
                      </Badge>
                    </div>
                  ))}

                  <div className="pt-3">
                    <Button
                      onClick={runSelfTest}
                      disabled={testing}
                      className="h-8 bg-console-blue hover:bg-console-blue/90 text-console-text font-mono text-[9px] uppercase tracking-wider gap-1.5 rounded"
                    >
                      {testing ? (
                        <RefreshCw className="size-3.5 animate-spin" />
                      ) : (
                        <Play className="size-3.5" />
                      )}
                      Execute Verification Self-Test
                    </Button>
                  </div>
                </CardContent>
              </Card>

              {/* Console log tracker */}
              <Card className="bg-console-deep border-console-border p-3 text-[9px] text-green-400 font-mono space-y-1 h-44 overflow-y-auto rounded">
                <div className="flex items-center gap-1 text-console-muted border-b border-console-border/30 pb-1 mb-1 font-bold text-[8px] uppercase tracking-widest">
                  <Terminal className="size-3" /> Self-Test Log Output
                </div>
                {selfTestLog.length === 0 ? (
                  <div className="text-green-400/30">
                    Console idle. Execute test to run system diagnostics.
                  </div>
                ) : (
                  selfTestLog.map((log, idx) => <div key={idx}>{log}</div>)
                )}
              </Card>
            </div>
          )}

          {/* Tab 2: Module 1 source credibility */}
          {activeTab === "mod1" && (
            <Card className="bg-console-surface border-console-border rounded relative overflow-hidden">
              <div className="absolute top-0 left-0 h-full w-0.5 bg-console-blue" />
              <CardHeader className="p-3 border-b border-console-border bg-console-deep/20 pb-2">
                <CardTitle className="text-[10px] font-bold uppercase tracking-widest text-console-muted">
                  Module 1: Source Credibility Evaluator
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4 space-y-4">
                {/*
                  The "Source Transparency" and "Cross-Citation Density" sliders
                  that sat here are gone. Neither was ever read by
                  evaluateSource — they defaulted to 30% and 40%, rendered as
                  filled progress bars next to a real score, and changed nothing
                  when dragged. Two invented percentages presented as analyst
                  input into an assessment they did not touch.
                */}
                <div className="space-y-1">
                  <label className="text-[9px] uppercase">News Source / Domain</label>
                  <Input
                    value={mod1Source}
                    onChange={(e) => setMod1Source(e.target.value)}
                    className="h-8 text-[11px] border-console-border bg-console-deep text-console-text rounded"
                  />
                </div>

                <Button
                  onClick={evaluateSource}
                  className="h-7 bg-console-blue hover:bg-console-blue/90 text-console-text font-mono text-[9px] uppercase px-3 rounded"
                >
                  Evaluate Publisher Tier
                </Button>

                {mod1Result && (
                  <div className="border border-console-border/40 bg-console-deep/60 rounded p-3 space-y-2 text-[10px]">
                    <div className="flex justify-between items-center border-b border-console-border/40 pb-1.5">
                      <span>Publisher tier score ({mod1Result.domain}):</span>
                      <strong className="text-console-text font-bold text-xs">
                        {mod1Result.score === null
                          ? "Unscored"
                          : `${mod1Result.score}/100 (${mod1Result.rating})`}
                      </strong>
                    </div>
                    <div className="flex justify-between text-[9px] text-console-muted">
                      <span>Reputation table ({mod1Result.tier}):</span>
                      <span className="text-console-cyan font-bold">
                        {mod1Result.reputation === null
                          ? "not listed"
                          : mod1Result.reputation.toFixed(2)}
                      </span>
                    </div>
                    <div className="flex justify-between text-[9px] text-console-muted">
                      <span>Engine confidence:</span>
                      <span className="text-console-text">
                        {typeof mod1Result.confidence === "number"
                          ? `${(mod1Result.confidence * 100).toFixed(0)}%`
                          : "not computed"}
                      </span>
                    </div>
                    <p className="pt-1 text-[9px] leading-relaxed text-console-muted">
                      {mod1Result.explanation}
                    </p>
                    {mod1Result.breakdown && mod1Result.breakdown.length > 0 && (
                      <div className="space-y-1 border-t border-console-border/30 pt-1.5">
                        <span className="text-[9px] font-bold text-console-text uppercase">
                          Factor Breakdown:
                        </span>
                        {mod1Result.breakdown.map((b: any) => (
                          <div
                            key={b.id}
                            className="flex justify-between text-[9px] text-console-muted"
                          >
                            <span>{b.name}:</span>
                            <span className="text-console-cyan">
                              score {b.rawScore.toFixed(2)} (w {b.weight.toFixed(2)})
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                    <p className="border-t border-console-border/30 pt-1.5 text-[9px] leading-relaxed text-console-label">
                      This scores the PUBLISHER only. Corroboration, citation depth, recency, source
                      diversity and linguistic markers need a real article and a collected corpus,
                      neither of which a source name supplies — they are not run here rather than
                      being scored against filler text.{" "}
                      <Link to="/sources" className="text-console-blue hover:underline">
                        Run the full seven-factor assessment on /sources
                      </Link>
                      .
                    </p>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Tab 3: Module 2 content analysis */}
          {activeTab === "mod2" && (
            <Card className="bg-console-surface border-console-border rounded relative overflow-hidden">
              <div className="absolute top-0 left-0 h-full w-0.5 bg-console-cyan" />
              <CardHeader className="p-3 border-b border-console-border bg-console-deep/20 pb-2">
                <CardTitle className="text-[10px] font-bold uppercase tracking-widest text-console-muted">
                  Module 2: NLP Content Extraction
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4 space-y-4">
                <div className="space-y-1">
                  <label className="text-[9px] uppercase">OSINT Wire Text Input</label>
                  <Textarea
                    value={mod2Text}
                    onChange={(e) => setMod2Text(e.target.value)}
                    className="min-h-20 text-[10.5px] border-console-border bg-console-deep text-console-text rounded font-mono"
                  />
                </div>

                <Button
                  onClick={evaluateModule2}
                  className="h-7 bg-console-cyan hover:bg-console-cyan/90 text-console-text font-mono text-[9px] uppercase px-3 rounded"
                >
                  Analyze Text
                </Button>

                {mod2Result && (
                  <div className="border border-console-border/40 bg-console-deep/60 rounded p-3 space-y-2.5 text-[10px]">
                    {mod2Result.error ? (
                      <div className="space-y-1">
                        <span className="font-bold text-console-red">AI unavailable</span>
                        <p className="text-[9px] leading-relaxed text-console-red/80">
                          No analysis was produced. {mod2Result.error}
                        </p>
                      </div>
                    ) : (
                      <>
                        <div className="text-[9px] uppercase text-console-label">
                          Generated by {mod2Result.model}
                        </div>
                        <div className="space-y-1">
                          <span className="text-console-muted/60 uppercase text-[9px] block">
                            Named entities ({mod2Result.ner.length}):
                          </span>
                          {mod2Result.ner.length === 0 ? (
                            <p className="text-console-muted">
                              The model extracted no entities from this text.
                            </p>
                          ) : (
                            <div className="flex flex-wrap gap-1">
                              {mod2Result.ner.map((ent: any, idx: number) => (
                                <Badge
                                  key={idx}
                                  variant="outline"
                                  className="border-console-border text-console-text bg-console-surface text-[8px] rounded-none h-4 uppercase"
                                >
                                  {ent.entity} · {ent.type} · {ent.confidence}
                                </Badge>
                              ))}
                            </div>
                          )}
                        </div>
                        <div className="flex justify-between">
                          <span>Topic:</span>
                          <strong className="text-console-text uppercase">{mod2Result.topic}</strong>
                        </div>
                        <div className="flex justify-between">
                          <span>Sentiment / threat level:</span>
                          <strong className="text-console-text uppercase">
                            {mod2Result.sentiment} / {mod2Result.threatLevel}
                          </strong>
                        </div>
                        <div className="space-y-0.5 border-t border-console-border/30 pt-1.5 mt-1.5">
                          <span className="text-console-muted/60 uppercase text-[9px] block font-bold">
                            Summary:
                          </span>
                          <p className="italic text-console-text">"{mod2Result.summary}"</p>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Tab 4: Module 3 — NOT IMPLEMENTED */}
          {activeTab === "mod3" && (
            <Card className="bg-console-surface border-console-border rounded relative overflow-hidden">
              <div className="absolute top-0 left-0 h-full w-0.5 bg-console-label" />
              <CardHeader className="p-3 border-b border-console-border bg-console-deep/20 pb-2">
                <CardTitle className="text-[10px] font-bold uppercase tracking-widest text-console-muted">
                  Module 3: Social Intelligence — Not Implemented
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4 space-y-3 text-[10px] text-console-muted font-mono leading-relaxed">
                <p className="text-console-amber">
                  This module does not produce a result. Nothing is calculated.
                </p>
                <p>
                  The previous version returned a bot likelihood of 88 or 24 depending on whether
                  the handle contained "bot" or "disinfo", an influencer score derived from the
                  length of the handle string, and a fixed "+124% weekly" growth figure. None of it
                  measured anything.
                </p>
                <p>
                  <span className="text-console-text font-bold">What does work:</span> Reddit RSS
                  collection and Google News <code>site:</code> queries, on the News and Recon
                  pages. Bot scoring, influence mapping and narrative alignment are not built.
                  Instagram and Facebook require paid API access.
                </p>
              </CardContent>
            </Card>
          )}

          {/* Tab 5: Module 4 — NOT IMPLEMENTED */}
          {activeTab === "mod4" && (
            <Card className="bg-console-surface border-console-border rounded relative overflow-hidden">
              <div className="absolute top-0 left-0 h-full w-0.5 bg-console-label" />
              <CardHeader className="p-3 border-b border-console-border bg-console-deep/20 pb-2">
                <CardTitle className="text-[10px] font-bold uppercase tracking-widest text-console-muted">
                  Module 4: Computer Vision — Not Implemented
                </CardTitle>
              </CardHeader>
              <CardContent className="p-4 space-y-3 text-[10px] text-console-muted font-mono leading-relaxed">
                <p className="text-console-amber">
                  This module does not produce a result. No image is read.
                </p>
                <p>
                  The previous version returned fixed OCR text, fixed EXIF metadata, a fixed "12%
                  likelihood of AI alteration" and a fixed object list — without opening any file.
                  The file selector listed mock filenames that were never loaded.
                </p>
                <p>
                  Deepfake and synthetic-media detection requires a vision model. None is
                  configured, and no honest free option exists within the current budget.
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </AppShell>
  );
}

// No `export default TasksPage` here — see the note in timeline.tsx. These two
// were the only route files of 32 carrying one, so it was a slip rather than a
// convention.
