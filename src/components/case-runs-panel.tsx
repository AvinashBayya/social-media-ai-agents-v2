import { useCallback, useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Layers, Plus, Play, Loader2, AlertTriangle, Network, Clock } from "lucide-react";
import { useNavigate } from "@tanstack/react-router";
import type { CaseRun, RunInputType, RunStatus } from "@/utils/cases/case-runs";
import {
  CASE_RUNS_CHANGED_EVENT,
  RUN_INPUT_TYPES,
  attachOsintRun,
  classifyRunInput,
  createCaseRun,
  deleteCaseRun,
  runStatusFromJobs,
  runsForCase,
  setRunStatus,
  summariseRuns,
  toCaseView,
} from "@/utils/cases/case-runs";
import type { Investigation } from "@/utils/investigations-store";
import {
  pollOsintInvestigationJob,
  startOsintInvestigationJob,
} from "@/utils/osint/jobs";
import type { InvestigationPoll, StartedInvestigation } from "@/utils/osint/jobs";
import { getGraphForCase, saveGraphSnapshot } from "@/utils/graph-store";
import { getTimelineForCase, saveTimelineSnapshot } from "@/utils/timeline-store";
import { SCOPE_CAVEATS } from "@/utils/cases/case-scope";
import { pinToInvestigation } from "@/utils/investigations-store";
import { toast } from "sonner";

/**
 * Case runs (2026-08-30, ported from the teammate's fork), with the execution
 * seam closed.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT THIS CLOSED, AND WHAT IT DELIBERATELY DID NOT.
 *
 * Before: this panel created a `CaseRun` and stopped. `attachOsintRun()` and
 * `setRunStatus()` existed and were tested but had **no production caller**, so
 * `osintInvestigationId` was permanently null and every run sat at QUEUED. The
 * only way forward was for the analyst to re-type the target into `/recon`.
 *
 * Now: **Run** drives the EXISTING lifecycle —
 *
 *   startOsintInvestigationJob()  →  attachOsintRun(runId, investigationId)
 *   pollOsintInvestigationJob()   →  setRunStatus(runId, derived)
 *
 * No second orchestrator, no second job system, no copy of the results. The run
 * stores the investigation id; the results stay in the job store, which is
 * already keyed by it. Copying them here would create a second, silently
 * staleable copy of the evidence.
 *
 * The poll loop is `/recon`'s, deliberately: same `stoppedRef` cleanup, same
 * interval, same stop-on-`done` condition. That component already solved
 * unmount-during-poll and it would be a mistake to solve it differently here.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * COMPLETED IS NOT `done`.
 *
 * `InvestigationPoll.done` means "no job is still running" — it is true when every
 * collector failed. So the status comes from `runStatusFromJobs()`, which returns
 * COMPLETED only when every job actually completed, and PARTIAL / FAILED /
 * CANCELLED otherwise. A case run must never read green because the collectors
 * were unavailable.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * DANGLING RUN IDS ARE A REAL STATE, NOT AN ERROR.
 *
 * The job store is in-memory unless `JOB_STORE_PATH` is set on a Bun runtime, so
 * results are lost on server restart and `pollOsintInvestigationJob` then throws
 * for an id it no longer knows. That is NOT a collector failure and is not
 * recorded as FAILED — doing so would assert something about the collectors that
 * never happened. It surfaces as an explicit "results no longer retrievable"
 * notice against the run, with its last recorded status left intact.
 */

const POLL_INTERVAL_MS = 1500;

const STATUS_STYLE: Record<RunStatus, string> = {
  QUEUED: "border-console-label/30 bg-console-label/10 text-console-muted",
  RUNNING: "border-console-blue/30 bg-console-blue/10 text-console-blue",
  COMPLETED: "border-console-green/30 bg-console-green/10 text-console-green",
  PARTIAL: "border-console-amber/30 bg-console-amber/10 text-console-amber",
  FAILED: "border-console-red/30 bg-console-red/10 text-console-red",
  CANCELLED: "border-console-label/30 bg-console-label/10 text-console-muted",
};

interface RunOutcome {
  poll: InvestigationPoll | null;
  /** Set when the run id no longer resolves — distinct from a collector failure. */
  unretrievable: string | null;
  error: string | null;
}

export function CaseRunsPanel({ investigation }: { investigation: Investigation }) {
  const navigate = useNavigate();
  const [runs, setRuns] = useState<CaseRun[]>([]);
  const [input, setInput] = useState("");
  const [inputType, setInputType] = useState<RunInputType | "AUTO">("AUTO");
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [outcomes, setOutcomes] = useState<Record<string, RunOutcome>>({});
  const stoppedRef = useRef(false);

  const refresh = useCallback(() => setRuns(runsForCase(investigation.id)), [investigation.id]);

  useEffect(() => {
    refresh();
    window.addEventListener(CASE_RUNS_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(CASE_RUNS_CHANGED_EVENT, refresh);
  }, [refresh]);

  // Stop every in-flight poll when the panel unmounts — `/recon`'s pattern.
  useEffect(() => {
    stoppedRef.current = false;
    return () => {
      stoppedRef.current = true;
    };
  }, []);

  const view = toCaseView(investigation);
  const summary = summariseRuns(runs);
  const detected = input.trim() ? classifyRunInput(input) : null;

  const mark = (runId: string, patch: Partial<RunOutcome>) =>
    setOutcomes((prev) => ({
      ...prev,
      // Defaults first, then any existing state, then the patch — order matters:
      // spreading the defaults last would wipe the patch every time.
      [runId]: { ...{ poll: null, unretrievable: null, error: null }, ...prev[runId], ...patch },
    }));

  const setBusyFor = (runId: string, on: boolean) =>
    setBusy((prev) => {
      const next = new Set(prev);
      if (on) next.add(runId);
      else next.delete(runId);
      return next;
    });

  const add = () => {
    if (!input.trim()) return;
    createCaseRun(
      { caseId: investigation.id, input, inputType: inputType === "AUTO" ? undefined : inputType },
      new Date().toISOString(),
    );
    setInput("");
    refresh();
  };

  /**
   * The ONLY route from collected evidence to case evidence.
   *
   * Deliberately an explicit analyst action, never automatic. Collector output is
   * an observation the run made; case evidence is something a person decided is
   * relevant. Auto-promoting 230 records would destroy that distinction and bury
   * the handful of items an analyst actually curated.
   *
   * Pins through the EXISTING `pinToInvestigation` — no new evidence model. The
   * collector's own provenance travels in `data` so nothing is lost in the
   * translation, and `kind: "note"` is used honestly because `EvidenceKind` has
   * no `osint` member; inventing one would widen a frozen union for a label.
   */
  const addCollectedToCase = (run: CaseRun, poll: InvestigationPoll) => {
    let added = 0;
    for (const ev of poll.evidence) {
      const ok = pinToInvestigation(run.caseId, {
        kind: "note",
        title: ev.evidenceId ?? `${ev.collector} observation`,
        source: ev.source,
        url: ev.sourceUrl ?? "",
        // An absent collection time stays absent — never back-filled to now.
        publishedAt: ev.collectedAt ?? "",
        note: `Promoted from case run ${run.id} (${run.input}).`,
        // Collector evidence carries a ConfidenceScore, not a Module 1
        // credibility score. They are different measurements, so this stays null
        // rather than borrowing a number from a different scale.
        credibility: null,
        credibilityRationale:
          "Collector evidence carries its own confidence, which is not the Module 1 credibility scale. Not converted.",
        excerpt: JSON.stringify(ev.normalizedValue).slice(0, 400),
        data: { collector: ev.collector, claimClass: ev.claimClass, confidence: ev.confidence },
      });
      if (ok) added += 1;
    }
    // `pinToInvestigation` de-dupes on url, so a re-promote is a no-op rather
    // than a duplicate — reported honestly either way.
    toast.success(
      added > 0
        ? `${added} collected record(s) promoted to case evidence.`
        : "Nothing new to promote — these records are already case evidence.",
    );
    refresh();
  };

  /**
   * Drives one run through the existing OSINT lifecycle.
   *
   * Every status written here is derived from the job layer's own per-job
   * statuses. Nothing is assumed.
   */
  const execute = async (run: CaseRun) => {
    if (busy.has(run.id)) return;
    setBusyFor(run.id, true);
    mark(run.id, { poll: null, error: null, unretrievable: null });

    let started: StartedInvestigation;
    try {
      started = (await startOsintInvestigationJob({
        data: { target: run.input },
      })) as StartedInvestigation;
    } catch (err) {
      // The planner or the start path failed. The run never reached the
      // collectors, so FAILED is the honest terminal state.
      setRunStatus(run.id, "FAILED", new Date().toISOString());
      mark(run.id, { error: err instanceof Error ? err.message : String(err) });
      setBusyFor(run.id, false);
      refresh();
      return;
    }

    // Record the id immediately, before any result exists. A crash after this
    // point leaves a run that can be re-polled rather than one that lost its id.
    attachOsintRun(run.id, started.investigationId, "RUNNING", new Date().toISOString());
    refresh();

    const tick = async () => {
      if (stoppedRef.current) return;
      let poll: InvestigationPoll;
      try {
        poll = (await pollOsintInvestigationJob({
          data: { investigationId: started.investigationId },
        })) as InvestigationPoll;
      } catch (err) {
        if (stoppedRef.current) return;
        // The id no longer resolves — the job store lost it (in-memory, restart).
        // NOT a collector failure: the run's last known status stays as it is.
        mark(run.id, { unretrievable: err instanceof Error ? err.message : String(err) });
        setBusyFor(run.id, false);
        return;
      }
      if (stoppedRef.current) return;

      mark(run.id, { poll });

      if (!poll.done) {
        setTimeout(tick, POLL_INTERVAL_MS);
        return;
      }

      // Terminal. COMPLETED only when every job completed — never off `done`.
      const status = runStatusFromJobs(poll.jobs);
      setRunStatus(run.id, status, new Date().toISOString());
      setBusyFor(run.id, false);
      refresh();

      // Hand off to /graph and /timeline exactly as /recon does. Raw inputs only.
      if (poll.entities.length > 0 || poll.relationships.length > 0) {
        saveGraphSnapshot({
          investigationId: started.investigationId,
          // Provenance comes from the RUN, never from whichever case the UI
          // happens to have selected. The run is the authoritative case
          // relationship.
          caseId: run.caseId,
          runId: run.id,
          target: run.input,
          savedAt: new Date().toISOString(),
          entities: poll.entities,
          relationships: poll.relationships,
        });
      }
      if (poll.evidence.length > 0) {
        saveTimelineSnapshot({
          investigationId: started.investigationId,
          caseId: run.caseId,
          runId: run.id,
          target: run.input,
          savedAt: new Date().toISOString(),
          evidence: poll.evidence,
        });
      }
    };

    void tick();
  };

  return (
    <div className="space-y-3 rounded border border-console-border bg-console-deep p-3 font-mono text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider text-console-purple">
          <Layers className="size-3" />
          Investigations in this case ({summary.total})
        </span>
        <span className="text-[9px] text-console-label">
          {view.caseNumber !== null ? `Case #${view.caseNumber}` : "no case number"} · {view.status} ·
          updated {view.updatedAt.slice(0, 10)}
        </span>
      </div>

      <div className="flex flex-wrap gap-1.5">
        <Input
          aria-label="Investigation input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && add()}
          placeholder="Domain, IP, email, phone, username or image filename"
          className="h-7 flex-1 rounded border-console-border bg-console-deep font-mono text-[10px] text-console-text placeholder:text-console-muted"
        />
        <select
          aria-label="Input type"
          value={inputType}
          onChange={(e) => setInputType(e.target.value as RunInputType | "AUTO")}
          className="h-7 rounded border border-console-border bg-console-deep px-1 font-mono text-[10px] text-console-text"
        >
          <option value="AUTO">Auto-detect</option>
          {RUN_INPUT_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          onClick={add}
          disabled={!input.trim()}
          className="h-7 gap-1 rounded bg-console-purple px-2 font-mono text-[9px] font-bold uppercase tracking-wider text-console-accent-foreground hover:bg-console-purple/90"
        >
          <Plus className="size-2.5" /> Add
        </Button>
      </div>
      {detected && inputType === "AUTO" && (
        <p className="text-[9px] text-console-label">Detected as {detected}.</p>
      )}

      {runs.length === 0 ? (
        <p className="text-[10px] leading-relaxed text-console-label">
          No investigations yet. Add an input above, then press Run — the passive collectors
          execute here and the results become this case's evidence, graph and timeline.
        </p>
      ) : (
        <div className="max-h-[26rem] overflow-y-auto rounded border border-console-border">
          {runs.map((r) => {
            const o = outcomes[r.id];
            const running = busy.has(r.id);
            return (
              <div key={r.id} className="space-y-1 border-b border-console-border/50 px-2 py-2 last:border-0">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <Badge className="h-4 rounded-none border-console-blue/30 bg-console-blue/10 px-1 text-[8px] text-console-blue">
                      {r.inputType}
                    </Badge>
                    <Badge className={`h-4 rounded-none px-1 text-[8px] ${STATUS_STYLE[r.status]}`}>
                      {r.status}
                    </Badge>
                    <span className="truncate text-[10px] text-console-text">{r.input}</span>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <Button
                      size="sm"
                      onClick={() => void execute(r)}
                      disabled={running}
                      className="h-6 gap-1 rounded bg-console-green px-2 font-mono text-[9px] font-bold uppercase tracking-wider text-console-accent-foreground hover:bg-console-green/90"
                    >
                      {running ? (
                        <Loader2 className="size-2.5 animate-spin" />
                      ) : (
                        <>
                          <Play className="size-2.5" /> {r.osintInvestigationId ? "Re-run" : "Run"}
                        </>
                      )}
                    </Button>
                    <button
                      onClick={() => {
                        deleteCaseRun(r.id);
                        refresh();
                      }}
                      className="text-[9px] text-console-label hover:text-console-red"
                    >
                      remove
                    </button>
                  </div>
                </div>

                <div className="text-[9px] text-console-label">
                  {r.osintInvestigationId
                    ? `OSINT run ${r.osintInvestigationId}`
                    : "not yet run — press Run to execute the passive collectors"}
                </div>

                {/* Live per-collector progress, straight from the job layer. */}
                {o?.poll && (
                  <div className="space-y-0.5">
                    <div className="flex flex-wrap gap-x-3 text-[9px] text-console-muted">
                      <span>{o.poll.jobs.filter((j) => j.status === "completed").length} collectors completed</span>
                      <span className="text-console-red">
                        {o.poll.jobs.filter((j) => j.status === "failed").length} unavailable
                      </span>
                      <span>{o.poll.entities.length} entities</span>
                    </div>

                    {/* The two evidence models are DIFFERENT things and are
                        labelled as such. Collected = what the collectors
                        returned. Case = what an analyst deliberately promoted.
                        Nothing here converts one into the other automatically. */}
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded border border-console-border bg-console-surface px-2 py-1 text-[9px]">
                      <span className="text-console-blue">
                        Collected evidence: {o.poll.evidence.length}
                      </span>
                      <span className="text-console-purple">
                        Case evidence: {investigation.evidence.length}
                      </span>
                      {o.poll.evidence.length > 0 && (
                        <button
                          onClick={() => addCollectedToCase(r, o.poll!)}
                          className="rounded border border-console-purple/40 px-1.5 py-0.5 font-bold uppercase tracking-wider text-console-purple hover:bg-console-purple/10"
                        >
                          + Add to case
                        </button>
                      )}
                      <span className="basis-full text-console-label">
                        Collected evidence belongs to the run. It becomes case evidence only when
                        an analyst promotes it.
                      </span>
                    </div>
                    {o.poll.done && (
                      <div className="flex flex-wrap gap-1.5 pt-0.5">
                        {/* Carry the case so /graph and /timeline open on THIS
                            case's snapshot, not whatever the unscoped/latest slot
                            holds. The run's own caseId is authoritative. */}
                        <button
                          onClick={() => void navigate({ to: "/graph", search: { case: r.caseId } })}
                          className="inline-flex items-center gap-1 text-[9px] text-console-purple hover:underline"
                        >
                          <Network className="size-2.5" /> graph
                        </button>
                        <button
                          onClick={() => void navigate({ to: "/timeline", search: { case: r.caseId } })}
                          className="inline-flex items-center gap-1 text-[9px] text-console-cyan hover:underline"
                        >
                          <Clock className="size-2.5" /> timeline
                        </button>
                      </div>
                    )}
                  </div>
                )}

                {/* A start/planner failure. */}
                {o?.error && (
                  <p className="rounded border border-console-red/30 bg-console-red/5 p-1.5 text-[9px] leading-relaxed text-console-red">
                    Run failed to start: {o.error}
                  </p>
                )}

                {/* NOT a collector failure — the id outlived the job store. */}
                {o?.unretrievable && (
                  <p className="rounded border border-console-amber/30 bg-console-amber/5 p-1.5 text-[9px] leading-relaxed text-console-amber">
                    Results are no longer retrievable for this run id. The job store is in-memory
                    unless configured otherwise, so results are lost when the server restarts. This
                    is not a collector failure — the recorded status above is left as it was. Press
                    Run again to execute afresh.
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}

      {summary.unstarted > 0 && (
        <div className="flex items-start gap-1.5 rounded border border-console-amber/30 bg-console-amber/5 p-2">
          <AlertTriangle className="size-3 shrink-0 text-console-amber" />
          <span className="text-[9px] leading-relaxed text-console-amber">
            {summary.unstarted} of {summary.total} investigations have not been run. Their absence
            from this case's evidence means nothing has been collected — not that nothing was found.
          </span>
        </div>
      )}
    </div>
  );
}
