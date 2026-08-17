import { createFileRoute } from "@tanstack/react-router";
import { AppShell, PageHeader, Tone } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useState, useEffect, useMemo } from "react";
import { toast } from "sonner";
import { getInvestigations, pinToInvestigation } from "@/utils/investigations-store";
import { getWatchlists } from "@/utils/watchlist-store";
import { fetchNews, fetchSocialIntelligence } from "./news";
import { fetchCyberThreats } from "./osint";
import { llmCaseSummary, llmExecutiveBrief, llmReport, llmExtractEntities } from "@/utils/llm";

import {
  Bot,
  RefreshCw,
  Terminal,
  FileText,
  ShieldCheck,
  Send,
  UserSearch,
  Activity,
  Layers,
  ArrowRightLeft,
  Pin,
} from "lucide-react";

export const Route = createFileRoute("/agents")({
  head: () => ({ meta: [{ title: "AI Intelligence Assistant — Sentinel AI" }] }),
  component: AgentsPage,
});

const CAPABILITIES = [
  {
    id: "SUMMARIZE_CASE",
    name: "Summarize Case Files",
    desc: "Compile dossier evidence into cohesive case summaries.",
  },
  {
    id: "EXEC_SUMMARY",
    name: "Generate Executive Summary",
    desc: "Construct high-level briefing memo for directors.",
  },
  {
    id: "TIMELINE",
    name: "Generate Timeline Log",
    desc: "Chronologically sort geocodes, social posts, and logs.",
  },
  {
    id: "EXPLAIN_ENTITY",
    name: "Explain Entity Attributes",
    desc: "Outline known aliases, IP mappings, and profiles.",
  },
  {
    id: "COMPARE_ENTITIES",
    name: "Compare Threat Entities",
    desc: "Evaluate overlap indices between two profiles.",
  },
  {
    id: "FIND_RELATIONSHIPS",
    name: "Find Node Relationships",
    desc: "Map correlation strings between CIB accounts.",
  },
  {
    id: "RECOMMENDATIONS",
    name: "Generate Containment Plans",
    desc: "Draft strategic risk mitigation and counter-measures.",
  },
  {
    id: "INTEL_REPORT",
    name: "Assemble Intelligence Report",
    desc: "Structure formal A4 analytical intelligence briefs.",
  },
  {
    id: "BRIEFING",
    name: "Generate Operational Briefing",
    desc: "Condense last 24h threat vectors into key bullet highlights.",
  },
  {
    id: "RISK_ASSESSMENT",
    name: "Perform Risk Assessment",
    desc: "Compute quantitative impact indices and risk curves.",
  },
  {
    id: "THREAT_CLASSIFY",
    name: "Multi-Domain Threat Classifier",
    desc: "Deterministically score threats across Military, Cyber, Geopolitical, Unrest & Infrastructure.",
  },
  {
    id: "FOCAL_POINT",
    name: "Spatio-Temporal Focal Point Detector",
    desc: "Identify event convergence clusters and emerging geographic hotspots.",
  },
];

function AgentsPage() {
  const [cases, setCases] = useState<any[]>([]);
  const [watchlists, setWatchlists] = useState<any[]>([]);

  // Selection states
  const [selectedCaseId, setSelectedCaseId] = useState("");
  const [selectedWatchlistId, setSelectedWatchlistId] = useState("");
  // These were pre-selected as "Vector-17" and "Aster Motors" — two invented
  // names that were then fed to the model as the analysis target (see
  // `activeTarget` below). Selection now starts empty and is populated only from
  // the analyst's own cases and watchlists.
  const [selectedEntityA, setSelectedEntityA] = useState("");
  const [selectedEntityB, setSelectedEntityB] = useState("");
  const [selectedCapability, setSelectedCapability] = useState("SUMMARIZE_CASE");

  // Output states
  const [loading, setLoading] = useState(false);
  const [outputResult, setOutputResult] = useState<any>(null);
  const [terminalLog, setTerminalLog] = useState<string[]>([]);

  // Load store filters
  useEffect(() => {
    setCases(getInvestigations());
    setWatchlists(getWatchlists());
  }, []);

  // Set default case
  useEffect(() => {
    if (cases.length > 0 && !selectedCaseId) {
      setSelectedCaseId(cases[0].id);
    }
  }, [cases]);

  /**
   * Entities the analyst can point an agent at.
   *
   * This set was seeded with five invented names — "Vector-17", "Aster Motors",
   * "Meridian Capital", "channel_9821", "Northwind Logistics" — with two of them
   * pre-selected, and the selection is passed to the model as the subject of the
   * analysis. Unlike /graph and /vault, this page carried no sample-data banner,
   * so nothing on screen distinguished them from an analyst's real subjects.
   * The list is now derived entirely from real cases and watchlists.
   */
  const availableEntities = useMemo(() => {
    const set = new Set<string>();
    cases.forEach((c) => {
      if (c.target) set.add(c.target);
      c.entities?.forEach((e: string) => set.add(e));
    });
    watchlists.forEach((w) => {
      w.filters?.people?.forEach((p: string) => set.add(p));
      w.filters?.organizations?.forEach((o: string) => set.add(o));
    });
    return Array.from(set);
  }, [cases, watchlists]);

  const activeCaseObj = cases.find((c) => c.id === selectedCaseId);

  // Execute analysis against the configured open-weight LLM provider
  const handleExecuteTask = async () => {
    const cap = selectedCapability;
    // `|| "General Target"` used to stand here, so with nothing selected the
    // model was asked to analyse a subject that does not exist and answered
    // about it anyway. Refuse instead of inventing a subject.
    const activeTarget = activeCaseObj ? activeCaseObj.target : selectedEntityA;
    if (!activeTarget) {
      toast.error("Select a case or a primary entity first — there is no subject to analyse.");
      return;
    }
    setLoading(true);
    setOutputResult(null);

    // Only the capabilities that actually call a model may log model activity.
    // THREAT_CLASSIFY and FOCAL_POINT are deterministic and make ZERO network
    // calls, yet both printed the full "[LLM] Dispatching prompt…" /
    // "[LLM] Response received." trace — fabricated telemetry for work no model
    // did, on the one panel an evaluator reads to see the model being used.
    const usesModel = !["THREAT_CLASSIFY", "FOCAL_POINT"].includes(cap);

    setTerminalLog([
      ...(usesModel
        ? ["[SYS] Connecting to configured LLM provider..."]
        : ["[SYS] Deterministic capability — no model provider is contacted."]),
      "[SYS] Fetching workspace telemetry...",
      `[CRAWLER] Case: ${selectedCaseId || "GLOBAL"} | Target: ${activeTarget}`,
      `[ANALYSER] Capability: ${cap}`,
      usesModel ? "[LLM] Dispatching prompt..." : "[SYS] Running local analysis...",
    ]);

    try {
      let title = "";
      let blocks: { heading: string; text: string; monospace?: boolean }[] = [];
      // No risk score. This was `activeCaseObj?.risk || 65`, defaulting to a
      // number nobody assigned, then fed to the model as "Risk Score: 65/100"
      // and rendered as "RISK 65%". Nothing in this system computes one.

      if (cap === "SUMMARIZE_CASE") {
        title = `INVESTIGATION DOSSIER: ${activeCaseObj?.title || "GENERAL"}`;
        const res = await llmCaseSummary({
          data: {
            // No case selected: say so, rather than naming a "General
            // Investigation" the model will then write about as if it existed.
            title: activeCaseObj?.title || `Ad-hoc analysis of ${activeTarget} (no case selected)`,
            target: activeTarget,
            description: activeCaseObj?.description || "No description recorded for this case.",
            // Negative means unassigned; llm.ts renders that as "not assigned by
            // the analyst - do not infer or estimate one".
            risk: -1,
          },
        });
        blocks = [{ heading: `AI-Generated Intelligence Summary (${res.model})`, text: res.text }];
      } else if (cap === "EXEC_SUMMARY") {
        title = `EXECUTIVE BRIEF: ${activeTarget}`;
        const res = await llmExecutiveBrief({
          data: {
            target: activeTarget,
            context:
              activeCaseObj?.description || `Senior command brief for subject ${activeTarget}.`,
          },
        });
        blocks = [
          { heading: `Director-Level Intelligence Briefing (${res.model})`, text: res.text },
        ];
      } else if (cap === "EXPLAIN_ENTITY") {
        title = `ENTITY DEEP DIVE: "${selectedEntityA}"`;
        const res = await llmExtractEntities({
          data: {
            text: `Provide a detailed intelligence analysis of entity: ${selectedEntityA}. Associated with case: ${activeTarget}. Include aliases, threat classification, network footprint, and recommended action.`,
          },
        });
        const entitiesText =
          Array.isArray(res.entities) && res.entities.length > 0
            ? res.entities
                .map((e: any) => `${e.type}: ${e.entity} (confidence: ${e.confidence})`)
                .join("\n")
            : "No entities were extracted from the supplied text.";
        blocks = [
          { heading: `NER Entity Extraction (${res.model})`, text: entitiesText, monospace: true },
        ];
      } else if (cap === "THREAT_CLASSIFY") {
        title = `MULTI-DOMAIN THREAT EVALUATION: "${activeTarget}"`;
        const { classifyThreatText } = await import("@/utils/threat-classifier");
        const evalResult = classifyThreatText(
          activeCaseObj?.description || `${activeTarget} military cyber infrastructure activity`,
        );
        blocks = [
          {
            heading: `Deterministic Threat Assessment`,
            text: [
              `Domain: ${evalResult.primaryDomain?.toUpperCase() ?? "not classified"}`,
              `Severity: ${evalResult.severity?.toUpperCase() ?? "not assessed"}`,
              `Confidence Score: ${
                evalResult.score === null ? "not scored" : `${(evalResult.score * 100).toFixed(0)}%`
              }`,
              `Indicators: ${evalResult.indicators.join(", ") || "none matched"}`,
              "",
              "Rationale:",
              evalResult.rationale,
            ].join("\n"),
          },
        ];
      } else if (cap === "FOCAL_POINT") {
        title = `SPATIO-TEMPORAL FOCAL POINT CONVERGENCE`;
        /*
         * This fed THREE HARDCODED EVENTS into the focal-point detector and
         * rendered the output as analysis:
         *
         *   { id: "ev1", lat: 31.76, lon: 35.21, title: "Event Alpha", ... }
         *   { id: "ev2", lat: 31.80, lon: 35.25, title: "Event Beta",  ... }
         *   { id: "ev3", lat: 31.78, lon: 35.22, title: "Event Gamma", ... }
         *
         * Those coordinates are Jerusalem. The panel then printed "3 events
         * converged at (31.78°, 35.2267°). Score: 6.5" — an invented
         * geographic finding, in the same application whose GIS module
         * documents removing exactly this class of thing.
         *
         * Convergence needs real located events. The map layers on /gis hold
         * them (USGS epicentres, UCDP events); this panel does not, and until
         * it is wired to them it must say so rather than demonstrate on
         * fictional input.
         */
        blocks = [
          {
            heading: `Hotspot Convergence Analysis`,
            text:
              "Not run. Convergence detection requires a set of real located, timestamped " +
              "events, and this panel is not yet wired to a collection that supplies them.\n\n" +
              "The detector itself (src/utils/focal-point.ts) is implemented and tested. " +
              "Located events are currently held by the GIS layers on /gis — USGS epicentres " +
              "and UCDP conflict events — and connecting those is the outstanding work.\n\n" +
              "This panel previously demonstrated the detector on three hardcoded coordinates " +
              "and presented the result as a finding.",
          },
        ];
      } else if (cap === "COMPARE_ENTITIES") {
        title = `CORRELATION INDEX: "${selectedEntityA}" vs "${selectedEntityB}"`;
        const res = await llmExecutiveBrief({
          data: {
            target: `${selectedEntityA} compared to ${selectedEntityB}`,
            context: `Perform an intelligence correlation analysis between ${selectedEntityA} and ${selectedEntityB}. Include shared infrastructure, coordinated behaviors, hashtag overlaps, and interaction strength.`,
          },
        });
        blocks = [{ heading: `Comparative Threat Intelligence (${res.model})`, text: res.text }];
      } else {
        const capLabels: Record<string, string> = {
          FIND_RELATIONSHIPS: "Relationship & Node Mapping Report",
          TIMELINE: "Chronological Event Timeline Analysis",
          RECOMMENDATIONS: "Containment & Mitigation Plan",
          INTEL_REPORT: "Full Analytical Intelligence Report",
          BRIEFING: "24-Hour Operational Briefing",
          RISK_ASSESSMENT: "Quantitative Risk Assessment",
        };
        title = `${capLabels[cap] || cap}: ${activeTarget}`;
        const res = await llmReport({
          data: {
            type: capLabels[cap] || cap,
            target: activeTarget,
            data: `Case: ${activeCaseObj?.title || "General"}. Description: ${activeCaseObj?.description || "No description recorded."}. Evidence pinned to this case: ${activeCaseObj?.evidence?.length ?? 0} item(s). Keywords: ${activeCaseObj?.keywords?.join(", ") || "none"}.`,
          },
        });
        blocks = [{ heading: `${capLabels[cap] || cap} (${res.model})`, text: res.text }];
      }

      setOutputResult({
        title,
        classification: "UNCLASSIFIED // DEMONSTRATOR",
        blocks,
      });
      setTerminalLog((prev) => [
        ...prev,
        usesModel ? "[LLM] Response received." : "[SYS] Local analysis complete.",
        "[SYS] Compilation complete. Output rendered in intel workspace.",
      ]);
      toast.success("AI analysis complete.");
    } catch (err: any) {
      setTerminalLog((prev) => [...prev, `[ERROR] ${err?.message || "LLM call failed."}`]);
      toast.error("AI unavailable — no result produced.");
    } finally {
      setLoading(false);
    }
  };

  // Pin generated briefing directly to the investigation case
  const handlePinReport = () => {
    if (!outputResult || !selectedCaseId) return;

    const success = pinToInvestigation(selectedCaseId, {
      kind: "note",
      title: outputResult.title,
      // `model` is never written by setOutputResult, so this recorded the
      // literal string "configured model" on every pinned briefing. The
      // producing model is named in the block heading instead.
      source: "AI briefing (see heading for the model that produced it)",
      publishedAt: new Date().toISOString(),
      excerpt: outputResult.blocks.map((b: any) => [b.heading, b.text].join("\n")).join("\n\n"),
      credibility: null,
      credibilityRationale:
        "AI-generated briefing, not a collected source. Requires analyst review before it is " +
        "treated as evidence.",
      data: outputResult,
    });

    if (success) {
      toast.success(`Report pinned to case ${selectedCaseId}`);
    } else {
      toast.error("Failed to pin report.");
    }
  };

  return (
    <AppShell>
      <PageHeader
        title="AI Intelligence Assistant"
        description="Structured analyst workspace. Select cases, target watchlists, and analytical models to compile classified summaries, node links, and threat containment memos."
      />

      <div className="grid gap-4 lg:grid-cols-[340px_1fr] font-mono text-xs text-[#94A3B8]">
        {/* Left Column: Command Console (No Chatbot Interface!) */}
        <div className="space-y-4">
          <Card className="bg-[#111827] border-[#263548] rounded relative overflow-hidden">
            <div className="absolute top-0 left-0 h-full w-0.5 bg-[#3B82F6]" />
            <CardHeader className="p-3 border-b border-[#263548] bg-[#0B1220]/20 pb-2">
              <CardTitle className="text-[10px] font-bold uppercase tracking-widest text-[#94A3B8] flex items-center gap-1.5">
                <Bot className="size-4 text-[#3B82F6]" /> Analytical Model parameters
              </CardTitle>
            </CardHeader>
            <CardContent className="p-3 space-y-3">
              {/* Select Case */}
              <div className="space-y-1">
                <label className="text-[9px] uppercase tracking-wider text-[#94A3B8]/60">
                  1. Target Investigation
                </label>
                <select
                  value={selectedCaseId}
                  onChange={(e) => setSelectedCaseId(e.target.value)}
                  className="w-full h-8 px-2 border border-[#263548] bg-[#0B1220] rounded text-[10px] text-white font-mono outline-none"
                >
                  <option value="">-- Global Query Context --</option>
                  {cases.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.id} · {c.title.substring(0, 18)}
                    </option>
                  ))}
                </select>
              </div>

              {/* Select Watchlist */}
              <div className="space-y-1">
                <label className="text-[9px] uppercase tracking-wider text-[#94A3B8]/60">
                  2. Correlated Watchlist
                </label>
                <select
                  value={selectedWatchlistId}
                  onChange={(e) => setSelectedWatchlistId(e.target.value)}
                  className="w-full h-8 px-2 border border-[#263548] bg-[#0B1220] rounded text-[10px] text-white font-mono outline-none"
                >
                  <option value="">-- No Watchlist Link --</option>
                  {watchlists.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </div>

              {/* Entity Inputs (for Compare/Explain) */}
              <div className="grid grid-cols-2 gap-2 pt-1">
                <div className="space-y-1">
                  <label className="text-[8px] uppercase text-[#94A3B8]/60">Primary Entity</label>
                  <select
                    value={selectedEntityA}
                    onChange={(e) => setSelectedEntityA(e.target.value)}
                    className="h-7 w-full rounded border border-[#263548] bg-[#0B1220] px-1.5 font-mono text-[9px] text-[#06B6D4] outline-none"
                  >
                    <option value="">-- select --</option>
                    {availableEntities.map((ent) => (
                      <option key={ent} value={ent}>
                        {ent}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-[8px] uppercase text-[#94A3B8]/60">Secondary Entity</label>
                  <select
                    value={selectedEntityB}
                    onChange={(e) => setSelectedEntityB(e.target.value)}
                    className="h-7 w-full rounded border border-[#263548] bg-[#0B1220] px-1.5 font-mono text-[9px] text-[#F59E0B] outline-none"
                  >
                    <option value="">-- select --</option>
                    {availableEntities.map((ent) => (
                      <option key={ent} value={ent}>
                        {ent}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              {availableEntities.length === 0 && (
                <p className="text-[9px] leading-relaxed text-[#64748B]">
                  No entities available. This list is built from the targets and keywords on your
                  own cases and watchlists — it previously offered five invented names. Create a
                  case or a watchlist to populate it.
                </p>
              )}

              {/* Select Capability Task */}
              <div className="space-y-1 pt-1.5 border-t border-[#263548]/30">
                <label className="text-[9px] uppercase tracking-wider text-[#94A3B8]/60">
                  3. Target Task Capability
                </label>
                <div className="space-y-1 max-h-40 overflow-y-auto pr-1">
                  {CAPABILITIES.map((cap) => (
                    <button
                      key={cap.id}
                      onClick={() => setSelectedCapability(cap.id)}
                      className={`w-full text-left px-2 py-1.5 border rounded text-[10px] transition-all flex flex-col ${selectedCapability === cap.id ? "border-[#3B82F6] bg-[#3B82F6]/5 text-white" : "border-[#263548]/40 bg-[#0B1220]/60 hover:bg-[#1A2332]"}`}
                    >
                      <span className="font-bold uppercase text-[9px]">{cap.name}</span>
                      <span className="text-[8px] text-[#94A3B8]/50 mt-0.5 leading-normal">
                        {cap.desc}
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Run button */}
              <div className="pt-2">
                <Button
                  onClick={handleExecuteTask}
                  disabled={loading}
                  className="w-full h-8 bg-[#3B82F6] hover:bg-[#3B82F6]/90 disabled:bg-[#1E293B] text-white font-mono text-[9px] uppercase tracking-wider gap-1.5 rounded"
                >
                  {loading ? (
                    <RefreshCw className="size-3.5 animate-spin" />
                  ) : (
                    <Send className="size-3.5" />
                  )}
                  Execute Analytical Model
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* Terminal telemetry panel */}
          <Card className="bg-[#0B1220] border-[#263548] p-3 text-[9px] text-green-400 font-mono space-y-1.5 h-36 overflow-y-auto rounded">
            <div className="flex items-center gap-1 text-[#94A3B8] border-b border-[#263548]/30 pb-1 mb-1 font-bold text-[8px] uppercase tracking-widest">
              <Terminal className="size-3" /> Console Logs
            </div>
            {terminalLog.length === 0 ? (
              <div className="text-green-400/30">
                Llm kernel ready. Select parameters and click Execute.
              </div>
            ) : (
              terminalLog.map((log, idx) => (
                <div key={idx} className="leading-relaxed">
                  {log}
                </div>
              ))
            )}
          </Card>
        </div>

        {/* Right Column: Intelligence Output Workspace (No Chatbot Interface!) */}
        <div className="space-y-4">
          <Card className="bg-[#111827] border-[#263548] rounded min-h-[480px] flex flex-col relative overflow-hidden">
            <div className="absolute top-0 left-0 h-full w-0.5 bg-[#EF4444]" />

            <CardHeader className="p-4 border-b border-[#263548] bg-[#0B1220]/20 flex flex-wrap justify-between items-center gap-3">
              <CardTitle className="text-[10px] font-bold uppercase tracking-widest text-[#94A3B8] flex items-center gap-1.5">
                <ShieldCheck className="size-4 text-[#EF4444]" /> Analytical Intelligence Briefing
                Card
              </CardTitle>
              {outputResult && (
                <Badge
                  variant="outline"
                  className="text-red-500 border-red-500/20 bg-red-500/5 text-[8px] font-mono tracking-wider font-bold"
                >
                  {outputResult.classification}
                </Badge>
              )}
            </CardHeader>

            <CardContent className="p-5 flex-1 flex flex-col justify-between space-y-6">
              {outputResult ? (
                <div className="space-y-5 flex-1 flex flex-col justify-between">
                  <div className="space-y-5">
                    {/* Header Details */}
                    <div className="border-b border-[#263548]/40 pb-3 flex justify-between items-start flex-wrap gap-4">
                      <div>
                        <span className="text-[9px] uppercase tracking-wider text-[#94A3B8]/60">
                          REPORT TITLE
                        </span>
                        <h2 className="text-sm font-bold text-white uppercase tracking-wide mt-0.5">
                          {outputResult.title}
                        </h2>
                      </div>
                      <div className="text-right">
                        <span className="text-[9px] uppercase tracking-wider text-[#94A3B8]/60">
                          THREAT INDEX
                        </span>
                      </div>
                    </div>

                    {/* Report Text blocks */}
                    <div className="space-y-4">
                      {outputResult.blocks.map((b: any, idx: number) => (
                        <div key={idx} className="space-y-1.5">
                          <h3 className="text-white uppercase font-bold text-[10px] tracking-wide flex items-center gap-1.5">
                            <Activity className="size-3.5 text-[#3B82F6]" /> {b.heading}
                          </h3>
                          {b.monospace ? (
                            <pre className="p-3 border border-[#263548]/40 bg-[#0B1220] text-[#06B6D4] text-[9.5px] rounded font-mono leading-relaxed overflow-x-auto whitespace-pre-wrap">
                              {b.text}
                            </pre>
                          ) : (
                            <p className="text-[#94A3B8] text-[11px] leading-relaxed pl-5 whitespace-pre-wrap">
                              {b.text}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Actions footer */}
                  <div className="pt-4 border-t border-[#263548]/40 flex justify-between items-center flex-wrap gap-3 mt-auto">
                    <span className="text-[8px] text-[#94A3B8]/40 uppercase tracking-widest font-mono">
                      AI-generated · not signed, not verified · Sentinel AI
                    </span>
                    <div className="flex gap-2">
                      <Button
                        onClick={handlePinReport}
                        variant="outline"
                        className="h-7 px-3 bg-[#0B1220] border-[#263548] text-white hover:bg-[#1A2332] text-[9px] uppercase font-mono gap-1.5 rounded-none"
                      >
                        <Pin className="size-3.5 text-[#3B82F6]" /> Pin Briefing to Case
                      </Button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex-1 flex flex-col items-center justify-center text-center text-[#94A3B8]/40 py-24">
                  <Bot className="size-10 text-[#263548] mb-3 animate-pulse" />
                  <h3 className="text-white text-xs font-bold uppercase tracking-wider">
                    Analyst Briefing Card Empty
                  </h3>
                  <p className="text-[10px] text-[#94A3B8]/60 mt-1 max-w-sm leading-normal">
                    Configure target investigation case parameters and select capability model on
                    the left to generate classified reports.
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </AppShell>
  );
}
