/**
 * Case runs — the missing join between a case and its OSINT investigations
 * (2026-08-30, ported from the teammate's fork).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THERE IS NO SECOND CASE MODEL HERE, AND THAT IS DELIBERATE.
 *
 * `investigations-store.ts`'s `Investigation` IS the case model — its own header
 * calls the records "Investigation case workspaces". It already carries id
 * (`INV-1001`), title, description, status, owner, keywords, evidence[], notes
 * and createdAt. Introducing a `Case` type beside it would duplicate that, and
 * would leave two things claiming to be the case of record.
 *
 * So this module adds only what was genuinely missing:
 *
 *   1. `caseNumber` and `updatedAt`, as DERIVED values rather than new stored
 *      fields — `caseNumber` is already encoded in the `INV-1001` id, and
 *      `updatedAt` can be computed from the newest pin. Nothing is migrated and
 *      no existing record changes shape.
 *   2. `CaseRun` — the record linking a case to one OSINT investigation run.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE NAMING COLLISION, WHICH IS THE REAL PROBLEM THIS SOLVES.
 *
 * Three unrelated things in this codebase are called "investigation":
 *
 *   1. `investigations-store.ts` `Investigation`  — the CASE (id `INV-1001`)
 *   2. `osint/orchestrator.ts`   `Investigation`  — one run's result bundle
 *   3. `osint/job-store.ts`      investigationId  — one run's id
 *      (`investigation-<base36>`)
 *
 * (2) and (3) had ZERO code path to (1): a case could not know which runs
 * produced its evidence, and a run could not know which case it belonged to.
 * `CaseRun` is that edge, and it stores the run id rather than the run's data —
 * results live in the job store, and copying them here would create a second,
 * silently-staleable copy of the evidence.
 */

import { localId } from "../local-id";
import type { Investigation } from "../investigations-store";
import { getInvestigations } from "../investigations-store";

// ─── Case status, mapped rather than replaced ───────────────────────────────

/** A stable spec-style vocabulary, distinct from the store's own labels. */
export const CASE_STATUSES = ["OPEN", "IN_PROGRESS", "CLOSED", "ARCHIVED"] as const;
export type CaseStatus = (typeof CASE_STATUSES)[number];

/**
 * Maps the STORED vocabulary onto the spec's.
 *
 * The store already uses Active/Triage/Watch/Closed, and those strings are in
 * every browser that has created a case plus the `/investigations` UI. Renaming
 * them would break stored data and existing screens for a vocabulary change that
 * buys nothing. Mapping is additive and reversible.
 */
export function toCaseStatus(stored: Investigation["status"]): CaseStatus {
  switch (stored) {
    case "Active":
      return "IN_PROGRESS";
    case "Triage":
      return "OPEN";
    case "Watch":
      return "OPEN";
    case "Closed":
      return "CLOSED";
    default:
      return "OPEN";
  }
}

// ─── Derived case view ──────────────────────────────────────────────────────

export interface CaseView {
  id: string;
  /** The numeric part of `INV-1001`. Null when the id does not carry one — never invented. */
  caseNumber: number | null;
  title: string;
  description: string;
  target: string;
  status: CaseStatus;
  /** The stored label, kept so the UI can show what is actually in the record. */
  storedStatus: Investigation["status"];
  createdAt: string;
  /**
   * Newest pin time, or `createdAt` when nothing has been pinned.
   *
   * DERIVED, not stored: adding a real `updatedAt` field would require touching
   * every write path and migrating existing records, for a value that is already
   * recoverable from the evidence. Documented so nobody mistakes it for a
   * mutation timestamp — editing a note does not move it.
   */
  updatedAt: string;
  evidenceCount: number;
}

export function caseNumberOf(id: string): number | null {
  const m = /^INV-(\d+)$/.exec(id ?? "");
  if (!m) return null;
  const n = Number.parseInt(m[1]!, 10);
  return Number.isFinite(n) ? n : null;
}

export function toCaseView(inv: Investigation): CaseView {
  const pinTimes = (inv.evidence ?? [])
    .map((e) => e.pinnedAt)
    .filter((t): t is string => typeof t === "string" && t.length > 0)
    .sort();
  return {
    id: inv.id,
    caseNumber: caseNumberOf(inv.id),
    title: inv.title,
    description: inv.description,
    target: inv.target,
    status: toCaseStatus(inv.status),
    storedStatus: inv.status,
    createdAt: inv.createdAt,
    updatedAt: pinTimes[pinTimes.length - 1] ?? inv.createdAt,
    evidenceCount: inv.evidence?.length ?? 0,
  };
}

export function listCases(): CaseView[] {
  return getInvestigations().map(toCaseView);
}

export function findCase(caseId: string): CaseView | null {
  const inv = getInvestigations().find((i) => i.id === caseId);
  return inv ? toCaseView(inv) : null;
}

// ─── Runs ───────────────────────────────────────────────────────────────────

/** A classifier output, plus IMAGE. Matches the planner's own target types. */
export const RUN_INPUT_TYPES = [
  "PERSON",
  "DOMAIN",
  "INFRASTRUCTURE",
  "EMAIL",
  "PHONE",
  "IMAGE",
] as const;
export type RunInputType = (typeof RUN_INPUT_TYPES)[number];

/**
 * Run status — the UPPERCASE form of the job system's own `ExecutionStatus`
 * (`collectors/result.ts`), which is already exactly these six values.
 *
 * A mapping onto existing semantics, not a parallel vocabulary: `COMPLETE`
 * became `COMPLETED` to match, and `PARTIAL`/`CANCELLED` are included because
 * the job layer produces them and a run that hides them would overstate what
 * happened.
 */
export const RUN_STATUSES = [
  "QUEUED",
  "RUNNING",
  "COMPLETED",
  "PARTIAL",
  "FAILED",
  "CANCELLED",
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** Statuses a run will not move on from. */
export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  "COMPLETED",
  "PARTIAL",
  "FAILED",
  "CANCELLED",
]);

/** The per-job shape this module reads. Structural, so it does not import the job layer. */
export interface RunJobStatusLike {
  status: string;
}

/**
 * Derives a run's status from its jobs' statuses.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE RULE THIS EXISTS TO ENFORCE: **COMPLETED requires that EVERY job
 * completed.**
 *
 * `InvestigationPoll.done` is `jobs.every(terminal)` — it means "nothing is still
 * running", NOT "everything succeeded". Reporting COMPLETED off `done` would mark
 * a case run green when every collector was unavailable, which is precisely the
 * misleading state this project forbids.
 *
 * Precedence, and why:
 *   - any job still queued/running   → RUNNING   (not finished, so not terminal)
 *   - no jobs at all                 → FAILED    (the planner selected nothing;
 *                                                 a run that executed nothing did
 *                                                 not succeed)
 *   - every job completed            → COMPLETED
 *   - every job cancelled            → CANCELLED
 *   - every job failed/cancelled     → FAILED    (nothing was collected)
 *   - anything else                  → PARTIAL   (some collected, some did not)
 */
export function runStatusFromJobs(jobs: readonly RunJobStatusLike[]): RunStatus {
  if (jobs.length === 0) return "FAILED";

  const statuses = jobs.map((j) => String(j.status).toLowerCase());
  const terminal = new Set(["completed", "partial", "failed", "cancelled"]);
  if (statuses.some((s) => !terminal.has(s))) return "RUNNING";

  if (statuses.every((s) => s === "completed")) return "COMPLETED";
  if (statuses.every((s) => s === "cancelled")) return "CANCELLED";
  // Nothing was successfully collected — "failed" is the honest word even when
  // the reason was cancellation of some jobs.
  if (statuses.every((s) => s === "failed" || s === "cancelled")) return "FAILED";
  return "PARTIAL";
}

export interface CaseRun {
  id: string;
  caseId: string;
  /** Exactly what the analyst typed. */
  input: string;
  /** Lowercased/trimmed form used for matching. */
  normalizedInput: string;
  inputType: RunInputType;
  status: RunStatus;
  /**
   * The OSINT job-system investigation id (`investigation-<base36>`), when a run
   * has been started. **The results are NOT copied here** — they live in the job
   * store, and duplicating them would create a second copy that goes stale
   * silently.
   */
  osintInvestigationId: string | null;
  createdAt: string;
  updatedAt: string;
}

const STORE_KEY = "sentinel_case_runs";
const STORE_VERSION_KEY = "sentinel_case_runs_version";
const STORE_VERSION = "1";

/** Fired after any write, mirroring `INVESTIGATIONS_CHANGED_EVENT`. */
export const CASE_RUNS_CHANGED_EVENT = "sentinel_case_runs_changed";

export function getCaseRuns(): CaseRun[] {
  if (typeof window === "undefined") return [];
  try {
    if (localStorage.getItem(STORE_VERSION_KEY) !== STORE_VERSION) {
      localStorage.removeItem(STORE_KEY);
      localStorage.setItem(STORE_VERSION_KEY, STORE_VERSION);
      return [];
    }
    const raw = localStorage.getItem(STORE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveCaseRuns(list: CaseRun[]): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(list));
    localStorage.setItem(STORE_VERSION_KEY, STORE_VERSION);
  } catch {
    // Quota or private mode. The caller's in-memory list is unaffected; only
    // persistence is lost, exactly as the sibling stores behave.
  }
  window.dispatchEvent(new CustomEvent(CASE_RUNS_CHANGED_EVENT));
}

/**
 * Classifies an input into a run type.
 *
 * Deliberately mirrors `query-planner.ts`'s `detectTargetType` precedence rather
 * than inventing a second classifier: an unambiguous shape wins, and anything
 * left over is PERSON. Kept as a separate small function because the planner's
 * version returns collector target types, not this run vocabulary.
 */
export function classifyRunInput(raw: string): RunInputType {
  const v = (raw ?? "").trim();
  if (!v) return "PERSON";
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(v)) return "INFRASTRUCTURE";
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return "EMAIL";
  if (/^\+?[\d\s().-]{7,}$/.test(v) && v.replace(/\D/g, "").length >= 7) return "PHONE";
  if (/\.(jpe?g|png|gif|webp|tiff?|bmp)$/i.test(v)) return "IMAGE";
  if (!v.includes(" ") && /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(v)) return "DOMAIN";
  return "PERSON";
}

export interface CreateRunInput {
  caseId: string;
  input: string;
  /** Omitted means classify it. Supplied means the analyst chose deliberately. */
  inputType?: RunInputType;
}

/**
 * Adds a run to a case.
 *
 * `now` is injected rather than read, so the function is pure enough to test —
 * the same discipline the extractors and timeline use.
 */
export function createCaseRun(input: CreateRunInput, now: string): CaseRun | null {
  const value = (input.input ?? "").trim();
  if (!input.caseId || !value) return null;

  const run: CaseRun = {
    id: localId("run"),
    caseId: input.caseId,
    input: value,
    normalizedInput: value.toLowerCase(),
    inputType: input.inputType ?? classifyRunInput(value),
    status: "QUEUED",
    osintInvestigationId: null,
    createdAt: now,
    updatedAt: now,
  };
  saveCaseRuns([run, ...getCaseRuns()]);
  return run;
}

export function runsForCase(caseId: string, all: CaseRun[] = getCaseRuns()): CaseRun[] {
  return all
    .filter((r) => r.caseId === caseId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
}

/** Records the OSINT job id and moves the run's status. Never invents a result. */
export function attachOsintRun(
  runId: string,
  osintInvestigationId: string,
  status: RunStatus,
  now: string,
): CaseRun | null {
  const all = getCaseRuns();
  const idx = all.findIndex((r) => r.id === runId);
  if (idx === -1) return null;
  const updated: CaseRun = {
    ...all[idx]!,
    osintInvestigationId,
    status,
    updatedAt: now,
  };
  all[idx] = updated;
  saveCaseRuns(all);
  return updated;
}

export function setRunStatus(runId: string, status: RunStatus, now: string): CaseRun | null {
  const all = getCaseRuns();
  const idx = all.findIndex((r) => r.id === runId);
  if (idx === -1) return null;
  const updated: CaseRun = { ...all[idx]!, status, updatedAt: now };
  all[idx] = updated;
  saveCaseRuns(all);
  return updated;
}

export function deleteCaseRun(runId: string): void {
  saveCaseRuns(getCaseRuns().filter((r) => r.id !== runId));
}

/** Removes every run belonging to a case — call when the case is deleted, so runs do not dangle. */
export function deleteRunsForCase(caseId: string): void {
  saveCaseRuns(getCaseRuns().filter((r) => r.caseId !== caseId));
}

export interface CaseRunSummary {
  total: number;
  byType: Record<string, number>;
  byStatus: Record<string, number>;
  /** Runs that were created but never started against the OSINT job system. */
  unstarted: number;
}

export function summariseRuns(runs: readonly CaseRun[]): CaseRunSummary {
  const byType: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  for (const r of runs) {
    byType[r.inputType] = (byType[r.inputType] ?? 0) + 1;
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  }
  return {
    total: runs.length,
    byType,
    byStatus,
    unstarted: runs.filter((r) => r.osintInvestigationId === null).length,
  };
}
