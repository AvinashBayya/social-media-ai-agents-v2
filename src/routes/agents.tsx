import { createFileRoute } from "@tanstack/react-router";
import { AppShell, PageHeader, Tone } from "@/components/app-shell";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { MarkdownReport } from "@/components/markdown-report";
import { useState, useEffect, useMemo } from "react";
import { toast } from "sonner";
import { getInvestigations, pinToInvestigation } from "@/utils/investigations-store";
import { getWatchlists } from "@/utils/watchlist-store";
import { getGraphForCase } from "@/utils/graph-store";
import { getTimelineForCase } from "@/utils/timeline-store";
import { getCaseRuns } from "@/utils/cases/case-runs";
import { planOsintInvestigation } from "@/utils/osint/jobs";
import type { OsintPlan } from "@/utils/osint/query-planner";
import { capabilityReport, type CapabilityReport } from "@/utils/collectors/capability-report";
import { GEOINT_DISCIPLINE_ROW } from "@/utils/cases/case-geoint";
import {
  NO_CASE_SELECTED,
  buildCaseContext,
  resolveCitation,
  sampleDerivedEntities,
  type CaseContext,
} from "@/utils/cases/case-context";
import { llmAnalyseCaseGrounded, type GroundedResult } from "@/utils/cases/case-analysis";
import { CaseContextDetail } from "@/components/case-context-detail";
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
  /**
   * `?case=INV-1001` preselects the target investigation — so "Open Agent" from a
   * case workspace lands on that case rather than the first in the list. Strict
   * about SHAPE only; a stale id simply leaves the picker on its default.
   */
  validateSearch: (search: Record<string, unknown>): { case?: string } => {
    const raw = search.case;
    if (typeof raw !== "string") return {};
    const trimmed = raw.trim();
    if (!trimmed || trimmed.length > 64) return {};
    return { case: trimmed };
  },
  head: () => ({ meta: [{ title: "AI Intelligence Assistant — Sentinel AI" }] }),
  component: AgentsPage,
});

/**
 * What each capability actually sends the model.
 *
 * An audit established, capability by capability, that ELEVEN of the twelve
 * below send the model case METADATA only — title, description, keyword
 * list, and in one case an integer COUNT of pinned evidence. No evidence text,
 * no entities, no relationships, no claims, no contradictions, no evidence ids,
 * no source URLs. Several are worse than uninformative:
 *
 *   - Six share one `llmReport` call with an IDENTICAL payload; only the `type`
 *     label differs, so "Chronological Event Timeline Analysis" and
 *     "Quantitative Risk Assessment" are the same request with different names.
 *   - COMPARE_ENTITIES puts a task INSTRUCTION into the field `llm.ts` labels to
 *     the model as "Collected context:".
 *   - EXPLAIN_ENTITY calls a NER extractor whose own prompt says "Only entities
 *     explicitly present in the text" — on a sentence containing two names.
 *
 * `grounded` marks the one capability that reasons over the case's real
 * evidence. The rest now say what they are, on screen, rather than implying an
 * analysis they cannot perform. Converting them is follow-on work, not this
 * phase; naming them costs nothing and stops the page overstating itself.
 */
const CAPABILITIES = [
  {
    // The only capability that reasons over the case's actual evidence. Every
    // other entry below sends the model case METADATA only, and now says so.
    id: "GROUNDED_CASE_ANALYSIS",
    name: "Grounded Case Analysis",
    desc: "Answer a question using this case's collected evidence, with citations that resolve.",
    grounded: true,
  },
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
  // A case handed in via `?case=` from a case workspace's "Open Agent" link.
  const { case: requestedCase } = Route.useSearch();

  const [cases, setCases] = useState<any[]>([]);
  const [watchlists, setWatchlists] = useState<any[]>([]);

  // Selection states
  const [selectedCaseId, setSelectedCaseId] = useState(requestedCase ?? "");
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

  /**
   * Entities the picker offers, and which of them are SAMPLE-derived.
   *
   * `watchlist-store.ts` seeds two `[SAMPLE]` watchlists whose people and
   * organizations ("Chen", "Ortega", "Vector-17", "Aster Motors", …) land in this
   * same list with nothing distinguishing them from a real case target. They are
   * now labelled.
   *
   * The GROUNDED capability is structurally immune either way: it builds its
   * context from case evidence and never reads a watchlist.
   */
  const sampleEntities = useMemo(() => sampleDerivedEntities(watchlists), [watchlists]);

  const activeCaseObj = cases.find((c) => c.id === selectedCaseId);

  // ── Real case context ───────────────────────────────────────────────────
  /**
   * The correlation layer needs the discipline matrix, and this route never
   * fetched it — so `buildCrossIntelligence` (inside `buildCaseContext`) would
   * run with an empty matrix and emit ZERO correlations regardless of the
   * data. A GEOINT correlation needs two disciplines (GEOINT from the attached
   * image, MEDIAINT from a news record), so without the matrix a correctly
   * attached image would still produce nothing.
   *
   * Same server function and same client-fetch shape the correlations panel
   * already uses. An unreadable matrix maps NOTHING — correlations are then
   * simply absent, never attributed to a guessed discipline.
   */
  const [capabilityRows, setCapabilityRows] = useState<CapabilityReport["rows"] | null>(null);
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = (await capabilityReport()) as unknown as CapabilityReport;
        if (!cancelled) setCapabilityRows(r.rows);
      } catch {
        if (!cancelled) setCapabilityRows([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const [caseContext, setCaseContext] = useState<CaseContext | null>(null);
  const [contextBlocker, setContextBlocker] = useState<string | null>(null);
  const [casePlan, setCasePlan] = useState<OsintPlan | null>(null);
  const [groundedQuestion, setGroundedQuestion] = useState("");
  const [grounded, setGrounded] = useState<GroundedResult | null>(null);

  /**
   * Plans the target so the context's completeness block carries the passive
   * policy's real refusal text. Planning is READ-ONLY — `planOsintInvestigation`
   * starts no job and enters nothing into the job store. A failure degrades to
   * `null`, which `assessCompleteness` reports as an unknown plan rather than as
   * full coverage.
   */
  useEffect(() => {
    if (!activeCaseObj?.target) {
      setCasePlan(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const plan = (await planOsintInvestigation({
          data: { target: activeCaseObj.target },
        })) as OsintPlan;
        if (!cancelled) setCasePlan(plan);
      } catch {
        if (!cancelled) setCasePlan(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeCaseObj?.target]);

  /**
   * Assembles what the grounded agent may see.
   *
   * The same case-scope rules as the case panels: a MISMATCH or UNSCOPED
   * verdict means the snapshot belongs elsewhere, and feeding it to a model
   * would attribute another case's evidence to this one — with citations that
   * look valid.
   */
  useEffect(() => {
    if (!selectedCaseId || !activeCaseObj) {
      setCaseContext(null);
      setContextBlocker(NO_CASE_SELECTED);
      setGrounded(null);
      return;
    }
    const graph = getGraphForCase(selectedCaseId);
    const timeline = getTimelineForCase(selectedCaseId);
    const graphOk = graph.verdict.result === "MATCH" && graph.snapshot;
    const timelineOk = timeline.verdict.result === "MATCH" && timeline.snapshot;

    if (!graphOk && !timelineOk) {
      setCaseContext(null);
      setContextBlocker(
        "This case has no stored run, so there is no collected evidence to reason over. That is a collection state, not a finding — nothing is substituted, and no other case's data is used.",
      );
      setGrounded(null);
      return;
    }
    setContextBlocker(null);
    const run = getCaseRuns().find((r) => r.caseId === selectedCaseId) ?? null;
    setCaseContext(
      buildCaseContext({
        caseId: selectedCaseId,
        caseTitle: activeCaseObj.title,
        target: activeCaseObj.target,
        description: activeCaseObj.description ?? "",
        // The SNAPSHOT's provenance is authoritative, not the selected run.
        runId: (timelineOk ? timeline.snapshot!.runId : graph.snapshot?.runId) ?? run?.id ?? null,
        investigationId:
          (timelineOk ? timeline.snapshot!.investigationId : graph.snapshot?.investigationId) ?? "",
        runStatus: run?.status ?? null,
        collectedAt: (timelineOk ? timeline.snapshot!.savedAt : graph.snapshot?.savedAt) ?? "",
        evidence: timelineOk ? timeline.snapshot!.evidence : [],
        entities: graphOk ? graph.snapshot!.entities : [],
        relationships: graphOk ? graph.snapshot!.relationships : [],
        plan: casePlan,
        // Same verdict gate as every sibling field — a bare `.snapshot` read
        // here would inherit another case's truncation via the unscoped
        // fallback.
        graphTruncation: graphOk ? graph.snapshot!.truncation : undefined,
        timelineTruncation: timelineOk ? timeline.snapshot!.truncation : undefined,
        extractedAt: new Date().toISOString(),
        capabilityRows: [...(capabilityRows ?? []), GEOINT_DISCIPLINE_ROW],
      }),
    );
  }, [selectedCaseId, activeCaseObj, casePlan, capabilityRows]);

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
    // Cleared here, not just on a successful grounded run: without this, running
    // Grounded Analysis and then switching to a different capability left the
    // stale grounded answer on screen — the render below shows `grounded` before
    // `outputResult`, so a freshly computed non-grounded result would silently
    // never appear.
    setGrounded(null);

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

      if (cap === "GROUNDED_CASE_ANALYSIS") {
        // The one capability that reasons over evidence. It REFUSES rather than
        // answering ungrounded — an answer with no case behind it is exactly the
        // fluent-but-attributable-to-nothing output this capability exists to
        // rule out.
        if (!caseContext) {
          throw new Error(
            contextBlocker ??
              "No case context is available. Select a case with a completed run before running grounded analysis.",
          );
        }
        if (!groundedQuestion.trim()) {
          throw new Error("Enter a question for the grounded analysis to answer.");
        }
        const res = (await llmAnalyseCaseGrounded({
          data: { context: caseContext, question: groundedQuestion },
        })) as unknown as GroundedResult;
        setGrounded(res);
        setTerminalLog((prev) => [
          ...prev,
          `[SYS] Grounded on case ${caseContext.caseId}: ${caseContext.evidence.length} evidence, ${caseContext.claims.length} claims, ${caseContext.contradictions.length} contradictions.`,
          `[SYS] Collection status ${caseContext.completeness.status}.`,
        ]);
        setOutputResult(null);
        setLoading(false);
        toast.success("Grounded analysis complete.");
        return;
      }

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

      <div className="grid gap-4 lg:grid-cols-[340px_1fr] font-mono text-xs text-console-muted">
        {/* Left Column: Command Console (No Chatbot Interface!) */}
        <div className="space-y-4">
          <Card className="bg-console-surface border-console-border rounded relative overflow-hidden">
            <div className="absolute top-0 left-0 h-full w-0.5 bg-console-blue" />
            <CardHeader className="p-3 border-b border-console-border bg-console-deep/20 pb-2">
              <CardTitle className="text-[10px] font-bold uppercase tracking-widest text-console-muted flex items-center gap-1.5">
                <Bot className="size-4 text-console-blue" /> Analytical Model parameters
              </CardTitle>
            </CardHeader>
            <CardContent className="p-3 space-y-3">
              {/* Select Case */}
              <div className="space-y-1">
                <label className="text-[9px] uppercase tracking-wider text-console-muted/60">
                  1. Target Investigation
                </label>
                <select
                  value={selectedCaseId}
                  onChange={(e) => setSelectedCaseId(e.target.value)}
                  className="w-full h-8 px-2 border border-console-border bg-console-deep rounded text-[10px] text-console-text font-mono outline-none"
                >
                  <option value="">-- Global Query Context --</option>
                  {cases.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.id} · {c.title.substring(0, 18)}
                    </option>
                  ))}
                </select>
              </div>

              {/* A "Correlated Watchlist" dropdown lived here. It was a dead
                  control — its value was written to state and never read by any
                  capability, so selecting a watchlist changed nothing. Removed
                  per this project's "wire it or remove it" rule rather than
                  inventing a correlation path no backend supports. */}

              {/* Entity Inputs (for Compare/Explain) */}
              <div className="grid grid-cols-2 gap-2 pt-1">
                <div className="space-y-1">
                  <label className="text-[8px] uppercase text-console-muted/60">Primary Entity</label>
                  <select
                    value={selectedEntityA}
                    onChange={(e) => setSelectedEntityA(e.target.value)}
                    className="w-full h-7 px-1.5 border border-console-border bg-console-deep rounded text-[9px] text-console-cyan font-mono outline-none"
                  >
                    <option value="">-- select --</option>
                    {availableEntities.map((ent) => (
                      <option key={ent} value={ent}>
                        {ent}
                        {sampleEntities.has(ent) ? "  [SAMPLE — not case evidence]" : ""}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1">
                  <label className="text-[8px] uppercase text-console-muted/60">Secondary Entity</label>
                  <select
                    value={selectedEntityB}
                    onChange={(e) => setSelectedEntityB(e.target.value)}
                    className="w-full h-7 px-1.5 border border-console-border bg-console-deep rounded text-[9px] text-console-amber font-mono outline-none"
                  >
                    <option value="">-- select --</option>
                    {availableEntities.map((ent) => (
                      <option key={ent} value={ent}>
                        {ent}
                        {sampleEntities.has(ent) ? "  [SAMPLE — not case evidence]" : ""}
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
              <div className="space-y-1 pt-1.5 border-t border-console-border/30">
                <label className="text-[9px] uppercase tracking-wider text-console-muted/60">
                  2. Target Task Capability
                </label>
                <div className="space-y-1 max-h-40 overflow-y-auto pr-1">
                  {/* Grounded-analysis controls and context summary */}
                  {selectedCapability === "GROUNDED_CASE_ANALYSIS" && (
                    <div className="mb-3 space-y-2 rounded border border-console-cyan/30 bg-console-deep p-2">
                      <p className="font-mono text-[9px] font-bold uppercase tracking-wider text-console-cyan">
                        Grounded in case evidence
                      </p>

                      {contextBlocker ? (
                        <p className="font-mono text-[9px] leading-relaxed text-console-amber">
                          {contextBlocker}
                        </p>
                      ) : caseContext ? (
                        <>
                          <p className="font-mono text-[9px] leading-relaxed text-console-label">
                            Case {caseContext.caseId} · run {caseContext.runId ?? "not recorded"} ·
                            collected {caseContext.collectedAt || "not recorded"} ·{" "}
                            <span className="text-console-amber">{caseContext.completeness.status} collection</span>
                          </p>
                          <p className="font-mono text-[9px] leading-relaxed text-console-muted">
                            {caseContext.evidence.length} evidence · {caseContext.entities.length} entities ·{" "}
                            {caseContext.relationships.length} relationships · {caseContext.claims.length} claims ·{" "}
                            {caseContext.contradictions.length} contradictions
                          </p>
                          <textarea
                            aria-label="Grounded question"
                            value={groundedQuestion}
                            onChange={(e) => setGroundedQuestion(e.target.value)}
                            placeholder="Ask a question this case's evidence can answer…"
                            className="h-16 w-full rounded border border-console-border bg-console-surface px-2 py-1 font-mono text-[10px] text-console-text outline-none focus:border-console-blue"
                          />
                          <p className="font-mono text-[9px] leading-relaxed text-console-label">
                            The model sees only this case's evidence. Answers that cite an id which
                            is not in this case are rejected and retried, then refused.
                          </p>
                        </>
                      ) : null}
                    </div>
                  )}

                  {CAPABILITIES.map((cap) => (
                    <button
                      key={cap.id}
                      onClick={() => setSelectedCapability(cap.id)}
                      className={`w-full text-left px-2 py-1.5 border rounded text-[10px] transition-all flex flex-col ${selectedCapability === cap.id ? "border-console-blue bg-console-blue/5 text-console-text" : "border-console-border/40 bg-console-deep/60 hover:bg-console-elevated"}`}
                    >
                      <span className="font-bold uppercase text-[9px]">{cap.name}</span>
                      <span className="text-[8px] text-console-muted/50 mt-0.5 leading-normal">
                        {cap.desc}
                        {!(cap as { grounded?: boolean }).grounded && (
                          <span className="mt-0.5 block font-mono text-[8px] uppercase tracking-wider text-console-amber">
                            Case metadata only — not grounded in collected evidence
                          </span>
                        )}
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
                  className="w-full h-8 bg-console-blue hover:bg-console-blue/90 disabled:bg-[#1E293B] text-console-text font-mono text-[9px] uppercase tracking-wider gap-1.5 rounded"
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
          <Card className="bg-console-deep border-console-border p-3 text-[9px] text-green-400 font-mono space-y-1.5 h-36 overflow-y-auto rounded">
            <div className="flex items-center gap-1 text-console-muted border-b border-console-border/30 pb-1 mb-1 font-bold text-[8px] uppercase tracking-widest">
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
          <Card className="bg-console-surface border-console-border rounded min-h-[480px] flex flex-col relative overflow-hidden">
            <div className="absolute top-0 left-0 h-full w-0.5 bg-console-red" />

            <CardHeader className="p-4 border-b border-console-border bg-console-deep/20 flex flex-wrap justify-between items-center gap-3">
              <CardTitle className="text-[10px] font-bold uppercase tracking-widest text-console-muted flex items-center gap-1.5">
                <ShieldCheck className="size-4 text-console-red" /> Analytical Intelligence Briefing
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

            <CardContent className="p-5 flex-1 flex flex-col space-y-6">
              {/* The selected case's collected intelligence, exposed as
                  compact detail from the CaseContext the page already builds.
                  Renders whenever a scoped case is selected (independent of the
                  chosen capability); a case with no scoped snapshot leaves
                  caseContext null and the left column shows the blocker instead. */}
              {caseContext && <CaseContextDetail context={caseContext} />}

              {/* ── Grounded answer, with citations that resolve ── */}
              {grounded ? (
                <div className="space-y-4">
                  <div className="border-b border-console-border/40 pb-2">
                    <span className="text-[9px] uppercase tracking-wider text-console-muted/60">
                      Grounded analysis · case {grounded.caseId}
                    </span>
                    <p className="mt-1 text-[11px] leading-relaxed text-console-text">{grounded.answer}</p>
                  </div>

                  <div className="space-y-2">
                    <h3 className="text-[10px] font-bold uppercase tracking-wide text-console-text">
                      Findings ({grounded.findings.length})
                    </h3>
                    {grounded.findings.map((f, i) => (
                      <div key={i} className="rounded border border-console-border bg-console-deep p-2">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-mono text-[9px] font-bold text-console-text">F-{i + 1}</span>
                          {/* The class badge is never optional — it is what stops an
                              INFERRED reading as an OBSERVED fact. */}
                          <Badge
                            variant="outline"
                            className={`text-[8px] font-normal ${
                              f.claimClass === "OBSERVED"
                                ? "border-console-green/40 bg-console-green/10 text-console-green"
                                : f.claimClass === "INFERRED" || f.claimClass === "HYPOTHESIS"
                                  ? "border-console-amber/40 bg-console-amber/10 text-console-amber"
                                  : "border-console-purple/40 bg-console-purple/10 text-console-purple"
                            }`}
                          >
                            {f.claimClass}
                          </Badge>
                        </div>
                        <p className="mt-1 text-[11px] leading-relaxed text-console-text">{f.statement}</p>

                        <div className="mt-1 flex flex-wrap items-center gap-1.5">
                          {f.evidenceRefs.length === 0 ? (
                            <span className="font-mono text-[9px] text-console-label">
                              no evidence cited — inference only
                            </span>
                          ) : (
                            f.evidenceRefs.map((ref) => {
                              // Every rendered citation is resolved against the
                              // context the model was given. An unresolvable one
                              // cannot reach here — validation rejects the answer —
                              // but it is checked again at render rather than assumed.
                              const rec = caseContext ? resolveCitation(caseContext, ref) : null;
                              return (
                                <a
                                  key={ref}
                                  href={`/vault?q=${encodeURIComponent(ref)}`}
                                  title={
                                    rec
                                      ? `${rec.collector} · ${rec.source} · ${rec.collectedAt}${rec.sourceUrl ? ` · ${rec.sourceUrl}` : ""}`
                                      : "This id is not in the supplied case context."
                                  }
                                  className={`font-mono text-[9px] underline ${
                                    rec ? "text-console-cyan" : "text-console-red"
                                  }`}
                                >
                                  [{ref}]
                                  {rec ? ` ${rec.collector}` : " UNRESOLVED"}
                                </a>
                              );
                            })
                          )}
                        </div>
                        {/* TWO different quantities, labelled apart. The class
                            badge above is the MODEL's classification; this is
                            the collectors' own confidence in the records cited,
                            computed in code after the model answered. */}
                        <p className="mt-0.5 text-[9px] leading-relaxed text-console-label">
                          Evidence confidence:{" "}
                          {f.evidenceConfidence.cited === 0 ? (
                            <span className="text-console-muted">no evidence cited</span>
                          ) : f.evidenceConfidence.band === null ? (
                            <span className="text-console-amber">
                              not measured by any cited collector ({f.evidenceConfidence.unmeasured} of{" "}
                              {f.evidenceConfidence.cited} records) — unmeasured is not weak, and not strong
                            </span>
                          ) : (
                            <span className="text-console-muted">
                              {f.evidenceConfidence.band} band, weakest cited record{" "}
                              {f.evidenceConfidence.min}
                              {f.evidenceConfidence.max !== f.evidenceConfidence.min &&
                                ` (range ${f.evidenceConfidence.min}–${f.evidenceConfidence.max})`}
                              {f.evidenceConfidence.unmeasured > 0 &&
                                ` · ${f.evidenceConfidence.unmeasured} cited record(s) unmeasured`}
                            </span>
                          )}
                        </p>
                        <p className="mt-0.5 text-[9px] italic leading-relaxed text-console-muted">
                          Basis (model's own reasoning): {f.basis}
                        </p>
                      </div>
                    ))}
                  </div>

                  <div className="space-y-1">
                    <h3 className="text-[10px] font-bold uppercase tracking-wide text-console-amber">
                      Not supported by this case's evidence
                    </h3>
                    <ul className="space-y-0.5">
                      {grounded.notSupported.map((n, i) => (
                        <li key={i} className="text-[9px] leading-relaxed text-console-muted">
                          - {n}
                        </li>
                      ))}
                    </ul>
                  </div>

                  <p className="rounded border border-console-amber/30 bg-console-amber/5 px-2 py-1 text-[9px] leading-relaxed text-console-amber">
                    {grounded.collectionCaveat}
                  </p>

                  {caseContext && (
                    <div className="space-y-0.5 border-t border-console-border/40 pt-2">
                      {caseContext.limitations.map((l) => (
                        <p key={l} className="text-[9px] leading-relaxed text-console-label">
                          {l}
                        </p>
                      ))}
                    </div>
                  )}

                  <p className="text-[9px] text-console-label">
                    Generated by {grounded.model} ({grounded.provider}). Citable evidence in this
                    case: {grounded.citableIds.length} record(s).
                  </p>
                </div>
              ) : outputResult ? (
                <div className="space-y-5 flex-1 flex flex-col justify-between">
                  <div className="space-y-5">
                    {/* Header Details */}
                    {/* A right-aligned "THREAT INDEX" label sat here with no
                        value ever rendered beneath it — a label implying a
                        measurement the system does not compute. Removed. */}
                    <div className="border-b border-console-border/40 pb-3">
                      <span className="text-[9px] uppercase tracking-wider text-console-muted/60">
                        REPORT TITLE
                      </span>
                      <h2 className="text-sm font-bold text-console-text uppercase tracking-wide mt-0.5">
                        {outputResult.title}
                      </h2>
                    </div>

                    {/* Report Text blocks */}
                    <div className="space-y-4">
                      {outputResult.blocks.map((b: any, idx: number) => (
                        <div key={idx} className="space-y-1.5">
                          <h3 className="text-console-text uppercase font-bold text-[10px] tracking-wide flex items-center gap-1.5">
                            <Activity className="size-3.5 text-console-blue" /> {b.heading}
                          </h3>
                          {b.monospace ? (
                            <pre className="p-3 border border-console-border/40 bg-console-deep text-console-cyan text-[9.5px] rounded font-mono leading-relaxed overflow-x-auto whitespace-pre-wrap">
                              {b.text}
                            </pre>
                          ) : (
                            <div className="pl-5">
                              <MarkdownReport text={b.text} className="text-[11px] text-console-muted" />
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Actions footer */}
                  <div className="pt-4 border-t border-console-border/40 flex justify-between items-center flex-wrap gap-3 mt-auto">
                    <span className="text-[8px] text-console-muted/40 uppercase tracking-widest font-mono">
                      AI-generated · not signed, not verified · Sentinel AI
                    </span>
                    <div className="flex gap-2">
                      <Button
                        onClick={handlePinReport}
                        disabled={!outputResult || !selectedCaseId}
                        title={
                          !selectedCaseId
                            ? "Select a target investigation above — pinning needs a case to pin to. \"Global Query Context\" has none."
                            : undefined
                        }
                        variant="outline"
                        className="h-7 px-3 bg-console-deep border-console-border text-console-text hover:bg-console-elevated text-[9px] uppercase font-mono gap-1.5 rounded-none"
                      >
                        <Pin className="size-3.5 text-console-blue" /> Pin Briefing to Case
                      </Button>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="flex-1 flex flex-col items-center justify-center text-center text-console-muted/40 py-24">
                  <Bot className="size-10 text-console-border mb-3 animate-pulse" />
                  <h3 className="text-console-text text-xs font-bold uppercase tracking-wider">
                    Analyst Briefing Card Empty
                  </h3>
                  <p className="text-[10px] text-console-muted/60 mt-1 max-w-sm leading-normal">
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
