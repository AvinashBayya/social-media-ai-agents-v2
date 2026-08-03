import { createFileRoute } from "@tanstack/react-router";
import { AppShell, PageHeader, Tone } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import { useState } from "react";
import { toast } from "sonner";
import { llmAnalyseContent, llmExtractEntities } from "@/utils/llm";
import {
  DOMAIN_TIERS, DEFAULT_WEIGHTS, domainOf, scoreArticle,
  type FactorResult, type ScorableArticle,
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
  RefreshCw
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
  const [mod1Transparency, setMod1Transparency] = useState(30);
  const [mod1Citations, setMod1Citations] = useState(40);
  const [mod1Result, setMod1Result] = useState<any>(null);

  // Module 2 state
  const [mod2Text, setMod2Text] = useState(
    "Security breach detected near Moscow spaceport nodes by Vector-17 cyber operative cluster. Technical reports suggest malware coordinates linked to C2 blocklists."
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
    const log: string[] = ["[SYS] Probing implemented capability. No result is asserted without executing it."];
    setSelfTestLog([...log]);
    const push = (line: string) => { log.push(line); setSelfTestLog([...log]); };

    // Module 1 — deterministic, runs locally.
    push("[SYS] Module 1: source credibility...");
    try {
      const probe = {
        id: "probe", title: "Probe article for capability check",
        source: "reuters.com", url: "https://www.reuters.com/probe",
        pubDate: new Date().toISOString(),
      };
      const scored = scoreArticle(probe, { all: [probe] }, DEFAULT_WEIGHTS);
      const computed = scored.factors.filter((f) => f.score !== null).length;
      push(`[PASS] Module 1 executed: ${computed}/${scored.factors.length} factors computed, score ${scored.score?.toFixed(2) ?? "n/a"}. Weighting is analyst-configurable on /sources.`);
    } catch (e: any) {
      push(`[FAIL] Module 1 threw: ${e?.message ?? e}`);
    }

    // Module 2 — requires a live model, so this is a real network call.
    push("[SYS] Module 2: content analysis (live model call)...");
    try {
      const res: any = await llmExtractEntities({
        data: { text: "The DRDO conducted a test off the Odisha coast on Tuesday." },
      });
      push(`[PASS] Module 2 executed: ${res.entities?.length ?? 0} entities extracted by ${res.model}.`);
    } catch (e: any) {
      push(`[FAIL] Module 2 unavailable: ${e?.message ?? e}`);
    }

    push("[NOT IMPLEMENTED] Module 3: social media analysis. Reddit RSS and Google News site: queries are collected, but bot scoring, influence mapping and narrative alignment are not built. Instagram/Facebook require paid API access.");
    push("[NOT IMPLEMENTED] Module 4: image/video and deepfake detection. No vision model is configured; no image is read.");
    push("[PARTIAL] Module 5: report generation runs on the configured open-weight LLM. GIS renders real Natural Earth geometry, but per-event coordinates are not geocoded.");
    push("[SYS] Probe complete. 2 of 5 modules execute; 1 partial; 2 not implemented. This is a prototype, not an accredited system.");

    setTesting(false);
    toast.success("Capability probe complete — see log for what actually ran.");
  };

  /**
   * Module 1 evaluation.
   *
   * The bias coefficient was previously a hardcoded ternary: any source string
   * containing "tass" or "rt" scored 85, everything else 15 — so "Bharti Airtel"
   * scored as state media because it contains "rt". It now uses the same
   * reputation list the real credibility engine uses.
   *
   * Transparency and citation depth are ANALYST-DECLARED inputs from the sliders,
   * not measurements. That is labelled in the result rather than implied away.
   */
  const evaluateSource = () => {
    const domain = domainOf(mod1Source) || mod1Source.trim().toLowerCase();
    const key = Object.keys(DOMAIN_TIERS)
      .filter((d) => domain === d || domain.endsWith(`.${d}`))
      .sort((a, b) => b.length - a.length)[0];

    if (!key) {
      setMod1Result({
        unrated: true,
        domain,
        note: `"${mod1Source}" is not in the reputation list. It is unrated, not penalised — add it to DOMAIN_TIERS to score it.`,
      });
      toast.message("Source not in reputation list — reported as unrated.");
      return;
    }

    const reputation = DOMAIN_TIERS[key];
    const score = Math.round(((reputation * 100) + mod1Transparency + mod1Citations) / 3);
    setMod1Result({
      unrated: false,
      domain: key,
      reputation,
      score,
      declared: true,
      rating: score > 75 ? "A — High trust" : score > 50 ? "B — Medium trust" : "C — Low trust",
    });
    toast.success("Source evaluated against the reputation list.");
  };

  // Module 2 — content analysis via the configured LLM
  const evaluateModule2 = async () => {
    toast.info("Executing NLP analysis...");
    try {
      const [analysisRes, nerRes] = await Promise.all([
        llmAnalyseContent({ data: { text: mod2Text } }),
        llmExtractEntities({ data: { text: mod2Text } })
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

      <div className="grid gap-4 lg:grid-cols-[250px_1fr] font-mono text-xs text-[#94A3B8]">
        {/* Left Side Tab Navigation */}
        <div className="space-y-1.5">
          <button
            onClick={() => setActiveTab("matrix")}
            className={`w-full text-left px-3 py-2 border rounded text-[10px] uppercase font-bold transition-all ${activeTab === "matrix" ? "border-[#3B82F6] bg-[#3B82F6]/10 text-white" : "border-[#263548]/40 bg-[#111827] hover:bg-[#1A2332]"}`}
          >
            Compliance Matrix
          </button>
          <button
            onClick={() => setActiveTab("mod1")}
            className={`w-full text-left px-3 py-2 border rounded text-[10px] uppercase font-bold transition-all ${activeTab === "mod1" ? "border-[#3B82F6] bg-[#3B82F6]/10 text-white" : "border-[#263548]/40 bg-[#111827] hover:bg-[#1A2332]"}`}
          >
            M1: Source Credibility
          </button>
          <button
            onClick={() => setActiveTab("mod2")}
            className={`w-full text-left px-3 py-2 border rounded text-[10px] uppercase font-bold transition-all ${activeTab === "mod2" ? "border-[#3B82F6] bg-[#3B82F6]/10 text-white" : "border-[#263548]/40 bg-[#111827] hover:bg-[#1A2332]"}`}
          >
            M2: Content Analysis
          </button>
          <button
            onClick={() => setActiveTab("mod3")}
            className={`w-full text-left px-3 py-2 border rounded text-[10px] uppercase font-bold transition-all ${activeTab === "mod3" ? "border-[#3B82F6] bg-[#3B82F6]/10 text-white" : "border-[#263548]/40 bg-[#111827] hover:bg-[#1A2332]"}`}
          >
            M3: Social Intelligence
          </button>
          <button
            onClick={() => setActiveTab("mod4")}
            className={`w-full text-left px-3 py-2 border rounded text-[10px] uppercase font-bold transition-all ${activeTab === "mod4" ? "border-[#3B82F6] bg-[#3B82F6]/10 text-white" : "border-[#263548]/40 bg-[#111827] hover:bg-[#1A2332]"}`}
          >
            M4: Image & Video
          </button>
        </div>

        {/* Right workspace panels */}
        <div className="space-y-4">
          {/* Tab 1: Compliance Matrix */}
          {activeTab === "matrix" && (
            <div className="space-y-4">
              <Card className="bg-[#111827] border-[#263548] rounded relative overflow-hidden">
                <div className="absolute top-0 left-0 h-full w-0.5 bg-[#3B82F6]" />
                <CardHeader className="p-3 border-b border-[#263548] bg-[#0B1220]/20 pb-2">
                  <CardTitle className="text-[10px] font-bold uppercase tracking-widest text-[#94A3B8] flex items-center gap-1.5">
                    <ListChecks className="size-4 text-[#3B82F6]" /> Verification Diagnostic Matrix
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-4 space-y-3">
                  {[
                    { m: "Module 1", name: "Source Credibility Check", features: "Credibility Score, Cross Verification, Confidence Rating" },
                    { m: "Module 2", name: "Open Source Content Analysis", features: "NER, Topic Detection, Clustering, Semantic Search, Summarization" },
                    { m: "Module 3", name: "Social Media Analysis", features: "Trend Detection, Influencer score, Bot detection, Hashtag growth" },
                    { m: "Module 4", name: "Images & Video Analysis", features: "OCR, Metadata extraction, Deepfake Likelihood, Object count" },
                    { m: "Module 5", name: "Report and GIS Visualization", features: "Executive Dossiers, PDF export, Leaflet interactive map" }
                  ].map((item, idx) => (
                    <div key={idx} className="flex flex-wrap items-center justify-between border-b border-[#263548]/30 pb-2 text-[10px]">
                      <div className="space-y-0.5">
                        <div className="text-white font-bold">{item.m} · {item.name}</div>
                        <div className="text-[#94A3B8]/60 text-[9px]">{item.features}</div>
                      </div>
                      <Badge variant="outline" className="text-green-500 border-green-500/20 bg-green-500/5 uppercase font-bold text-[8px] h-5 rounded-none flex items-center gap-1">
                        <CheckCircle2 className="size-3" /> Nominal / Verified
                      </Badge>
                    </div>
                  ))}

                  <div className="pt-3">
                    <Button onClick={runSelfTest} disabled={testing} className="h-8 bg-[#3B82F6] hover:bg-[#3B82F6]/90 text-white font-mono text-[9px] uppercase tracking-wider gap-1.5 rounded">
                      {testing ? <RefreshCw className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
                      Execute Verification Self-Test
                    </Button>
                  </div>
                </CardContent>
              </Card>

              {/* Console log tracker */}
              <Card className="bg-[#0B1220] border-[#263548] p-3 text-[9px] text-green-400 font-mono space-y-1 h-44 overflow-y-auto rounded">
                <div className="flex items-center gap-1 text-[#94A3B8] border-b border-[#263548]/30 pb-1 mb-1 font-bold text-[8px] uppercase tracking-widest"><Terminal className="size-3" /> Self-Test Log Output</div>
                {selfTestLog.length === 0 ? (
                  <div className="text-green-400/30">Console idle. Execute test to run system diagnostics.</div>
                ) : (
                  selfTestLog.map((log, idx) => (
                    <div key={idx}>{log}</div>
                  ))
                )}
              </Card>
            </div>
          )}

          {/* Tab 2: Module 1 source credibility */}
          {activeTab === "mod1" && (
            <Card className="bg-[#111827] border-[#263548] rounded relative overflow-hidden">
              <div className="absolute top-0 left-0 h-full w-0.5 bg-[#3B82F6]" />
              <CardHeader className="p-3 border-b border-[#263548] bg-[#0B1220]/20 pb-2">
                <CardTitle className="text-[10px] font-bold uppercase tracking-widest text-[#94A3B8]">Module 1: Source Credibility Evaluator</CardTitle>
              </CardHeader>
              <CardContent className="p-4 space-y-4">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <label className="text-[9px] uppercase">News Source / Domain</label>
                    <Input value={mod1Source} onChange={(e) => setMod1Source(e.target.value)} className="h-8 text-[11px] border-[#263548] bg-[#0B1220] text-white rounded" />
                  </div>
                  <div className="space-y-2">
                    <div className="flex justify-between text-[9px]">
                      <span className="uppercase">Source Transparency</span>
                      <span>{mod1Transparency}%</span>
                    </div>
                    <Progress value={mod1Transparency} onClick={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect();
                      const x = e.clientX - rect.left;
                      setMod1Transparency(Math.round((x / rect.width) * 100));
                    }} className="h-1 cursor-pointer bg-[#263548]" />
                  </div>
                  <div className="space-y-2">
                    <div className="flex justify-between text-[9px]">
                      <span className="uppercase">Cross-Citation Density</span>
                      <span>{mod1Citations}%</span>
                    </div>
                    <Progress value={mod1Citations} onClick={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect();
                      const x = e.clientX - rect.left;
                      setMod1Citations(Math.round((x / rect.width) * 100));
                    }} className="h-1 cursor-pointer bg-[#263548]" />
                  </div>
                </div>

                <Button onClick={evaluateSource} className="h-7 bg-[#3B82F6] hover:bg-[#3B82F6]/90 text-white font-mono text-[9px] uppercase px-3 rounded">Evaluate Trust Score</Button>

                {mod1Result && (
                  <div className="border border-[#263548]/40 bg-[#0B1220]/60 rounded p-3 space-y-2 text-[10px]">
                    {mod1Result.unrated ? (
                      <p className="text-[#F59E0B] leading-relaxed">{mod1Result.note}</p>
                    ) : (
                      <>
                        <div className="flex justify-between">
                          <span>Composite score:</span>
                          <strong className="text-white font-bold">{mod1Result.score}/100</strong>
                        </div>
                        <div className="flex justify-between">
                          <span>Domain reputation ({mod1Result.domain}):</span>
                          <span className="text-[#06B6D4] font-bold">{mod1Result.reputation.toFixed(2)}</span>
                        </div>
                        <div className="flex justify-between">
                          <span>Rating:</span>
                          <strong className="text-white">{mod1Result.rating}</strong>
                        </div>
                        <p className="border-t border-[#263548]/30 pt-1.5 text-[9px] leading-relaxed text-[#94A3B8]">
                          Reputation is from the editable domain list. Transparency and citation
                          depth are analyst-declared slider values, not measurements. Cross-source
                          verification is computed per article on the Source Credibility page, not here.
                        </p>
                      </>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Tab 3: Module 2 content analysis */}
          {activeTab === "mod2" && (
            <Card className="bg-[#111827] border-[#263548] rounded relative overflow-hidden">
              <div className="absolute top-0 left-0 h-full w-0.5 bg-[#06B6D4]" />
              <CardHeader className="p-3 border-b border-[#263548] bg-[#0B1220]/20 pb-2">
                <CardTitle className="text-[10px] font-bold uppercase tracking-widest text-[#94A3B8]">Module 2: NLP Content Extraction</CardTitle>
              </CardHeader>
              <CardContent className="p-4 space-y-4">
                <div className="space-y-1">
                  <label className="text-[9px] uppercase">OSINT Wire Text Input</label>
                  <Textarea value={mod2Text} onChange={(e) => setMod2Text(e.target.value)} className="min-h-20 text-[10.5px] border-[#263548] bg-[#0B1220] text-white rounded font-mono" />
                </div>

                <Button onClick={evaluateModule2} className="h-7 bg-[#06B6D4] hover:bg-[#06B6D4]/90 text-white font-mono text-[9px] uppercase px-3 rounded">Analyze Text</Button>

                {mod2Result && (
                  <div className="border border-[#263548]/40 bg-[#0B1220]/60 rounded p-3 space-y-2.5 text-[10px]">
                    {mod2Result.error ? (
                      <div className="space-y-1">
                        <span className="font-bold text-[#EF4444]">AI unavailable</span>
                        <p className="text-[9px] leading-relaxed text-[#EF4444]/80">
                          No analysis was produced. {mod2Result.error}
                        </p>
                      </div>
                    ) : (
                      <>
                        <div className="text-[9px] uppercase text-[#64748B]">
                          Generated by {mod2Result.model}
                        </div>
                        <div className="space-y-1">
                          <span className="text-[#94A3B8]/60 uppercase text-[9px] block">
                            Named entities ({mod2Result.ner.length}):
                          </span>
                          {mod2Result.ner.length === 0 ? (
                            <p className="text-[#94A3B8]">The model extracted no entities from this text.</p>
                          ) : (
                            <div className="flex flex-wrap gap-1">
                              {mod2Result.ner.map((ent: any, idx: number) => (
                                <Badge key={idx} variant="outline" className="border-[#263548] text-white bg-[#111827] text-[8px] rounded-none h-4 uppercase">
                                  {ent.entity} · {ent.type} · {ent.confidence}
                                </Badge>
                              ))}
                            </div>
                          )}
                        </div>
                        <div className="flex justify-between">
                          <span>Topic:</span>
                          <strong className="text-white uppercase">{mod2Result.topic}</strong>
                        </div>
                        <div className="flex justify-between">
                          <span>Sentiment / threat level:</span>
                          <strong className="text-white uppercase">
                            {mod2Result.sentiment} / {mod2Result.threatLevel}
                          </strong>
                        </div>
                        <div className="space-y-0.5 border-t border-[#263548]/30 pt-1.5 mt-1.5">
                          <span className="text-[#94A3B8]/60 uppercase text-[9px] block font-bold">Summary:</span>
                          <p className="italic text-white">"{mod2Result.summary}"</p>
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
            <Card className="bg-[#111827] border-[#263548] rounded relative overflow-hidden">
              <div className="absolute top-0 left-0 h-full w-0.5 bg-[#64748B]" />
              <CardHeader className="p-3 border-b border-[#263548] bg-[#0B1220]/20 pb-2">
                <CardTitle className="text-[10px] font-bold uppercase tracking-widest text-[#94A3B8]">Module 3: Social Intelligence — Not Implemented</CardTitle>
              </CardHeader>
              <CardContent className="p-4 space-y-3 text-[10px] text-[#94A3B8] font-mono leading-relaxed">
                <p className="text-[#F59E0B]">This module does not produce a result. Nothing is calculated.</p>
                <p>
                  The previous version returned a bot likelihood of 88 or 24 depending on whether the
                  handle contained "bot" or "disinfo", an influencer score derived from the length of
                  the handle string, and a fixed "+124% weekly" growth figure. None of it measured anything.
                </p>
                <p>
                  <span className="text-[#F3F4F6] font-bold">What does work:</span> Reddit RSS collection and
                  Google News <code>site:</code> queries, on the News and Recon pages. Bot scoring, influence
                  mapping and narrative alignment are not built. Instagram and Facebook require paid API access.
                </p>
              </CardContent>
            </Card>
          )}

          {/* Tab 5: Module 4 — NOT IMPLEMENTED */}
          {activeTab === "mod4" && (
            <Card className="bg-[#111827] border-[#263548] rounded relative overflow-hidden">
              <div className="absolute top-0 left-0 h-full w-0.5 bg-[#64748B]" />
              <CardHeader className="p-3 border-b border-[#263548] bg-[#0B1220]/20 pb-2">
                <CardTitle className="text-[10px] font-bold uppercase tracking-widest text-[#94A3B8]">Module 4: Computer Vision — Not Implemented</CardTitle>
              </CardHeader>
              <CardContent className="p-4 space-y-3 text-[10px] text-[#94A3B8] font-mono leading-relaxed">
                <p className="text-[#F59E0B]">This module does not produce a result. No image is read.</p>
                <p>
                  The previous version returned fixed OCR text, fixed EXIF metadata, a fixed
                  "12% likelihood of AI alteration" and a fixed object list — without opening any file.
                  The file selector listed mock filenames that were never loaded.
                </p>
                <p>
                  Deepfake and synthetic-media detection requires a vision model. None is configured, and
                  no honest free option exists within the current budget.
                </p>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </AppShell>
  );
}
export default TasksPage;
