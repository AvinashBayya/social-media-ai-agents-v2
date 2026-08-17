/**
 * Job system — OSINT-INTEGRATION-PLAN.md §12.
 *
 * `orchestrator.ts`'s `runInvestigation()` blocks on every collector inside
 * one call — fine for a page that can wait a few seconds, wrong for
 * "external tools must not run inside a normal browser request for an
 * extended period" once theHarvester/SpiderFoot (external processes, §13-15,
 * not built yet) join the collector set. This file is the async, pollable
 * sibling: `startInvestigation()` returns immediately with an id, and
 * `pollInvestigation(id)` reports current state — matching §12's sketched
 * API shape (`POST /investigation` → id, `GET /investigation/:id` → state).
 *
 * Built on exactly the same query planner and collector registry as
 * `orchestrator.ts`; the two files do not duplicate collector-selection or
 * merge logic (`./merge.ts` is shared by both).
 *
 * `startOsintInvestigationJob`/`pollOsintInvestigationJob` at the bottom are
 * the `createServerFn` wrappers `/recon`'s "OSINT Investigation" panel
 * polls (added 2026-08-14, plan §31 P2 "Progress") — this file's core logic
 * was otherwise unreachable from the app since the day it was written,
 * exactly the "control with no handler" pattern CLAUDE.md's fabrication
 * audit warns about (that one was theHarvester/SpiderFoot never being
 * registered; this was the whole job system never being called).
 *
 * **Persistence: in-memory by default, optionally SQLite.** `jobStore`'s
 * concrete backend is chosen by `createJobStore()` below from
 * `JOB_STORE_PATH` — unset (the default) keeps the original in-memory,
 * lost-on-restart behavior; set to a file path, jobs survive a scale-to-zero
 * cold start between `POST` and the next `GET` (`job-store-sqlite.ts`).
 * PostgreSQL for production, per plan §16, is not attempted — no database
 * service exists to point it at in this deployment.
 *
 * **"queued" is real but short-lived for P1's built-in collectors.** They
 * run in-process with nothing to hand off to, so a job moves to "running"
 * essentially immediately. A genuine queue with backpressure only becomes
 * meaningful once external worker processes exist.
 *
 * **Cancellation is honest about its limit.** `Collector.execute()` (the P0
 * contract) takes no `AbortSignal`, so a job cancelled while its collector
 * is mid-flight cannot actually stop the underlying request — `cancelJob()`
 * marks the job cancelled and `pollInvestigation()` stops reporting it, but
 * the in-flight fetch still runs to completion in the background with its
 * result discarded. Real cancellation needs an `AbortSignal` threaded
 * through the collector contract, a P0 change not made here.
 */

import { createServerFn } from "@tanstack/react-start";
import type {
  CollectorEntity,
  CollectorEvidence,
  CollectorRelationship,
} from "../collectors/result";
import type { CollectorRegistry } from "../collectors/registry";
import { collectorRegistry } from "../collectors/registry";
import { registerExistingCollectors } from "../collectors/existing";
import { registerExternalCollectors } from "../collectors/external";
import { dedupeEntitiesById, dedupeRelationships } from "./merge";
import type { OsintPlan } from "./query-planner";
import { planInvestigation } from "./query-planner";
import type { InvestigationJob, JobResult, JobStatus, JobStore } from "./job-store";
import { InMemoryJobStore } from "./job-store";
import { SqliteJobStore } from "./job-store-sqlite";

export type { JobStatus, InvestigationJob, JobStore } from "./job-store";
export { InMemoryJobStore } from "./job-store";
export { SqliteJobStore } from "./job-store-sqlite";

const TERMINAL_STATUSES: readonly JobStatus[] = ["completed", "partial", "failed", "cancelled"];

/**
 * Config-driven store selection — the same "point at a different backend,
 * no application code changes" philosophy `llm.ts`'s `LLM_BASE_URL` uses.
 * Unset (the default) keeps the original in-memory, lost-on-restart
 * behavior exactly as it always was. Setting `JOB_STORE_PATH` to a file path
 * (conventionally `./data/jobs.sqlite`, matching `credential-vault.ts`'s own
 * `./data/` convention) switches to `SqliteJobStore` with zero other code
 * changes — every function below only ever depends on the `JobStore`
 * interface, never on which concrete class `jobStore` is.
 */
function createJobStore(): JobStore {
  const path = process.env.JOB_STORE_PATH?.trim();
  return path ? new SqliteJobStore(path) : new InMemoryJobStore();
}

/** Process-wide job store. Nothing writes to this except an explicit call — see the file header on persistence, and `createJobStore()` above for how the backend is chosen. */
export const jobStore: JobStore = createJobStore();

/** Outer safety-net timeout, independent of whatever timeout a collector already applies to itself internally (e.g. crt.sh's own 50s budget). */
export const JOB_TIMEOUT_MS = 60_000;

async function runJob(
  jobId: string,
  registry: CollectorRegistry,
  store: JobStore,
  timeoutMs: number,
): Promise<void> {
  const job = store.getJob(jobId);
  if (!job || job.status === "cancelled") return;

  store.updateJob(jobId, {
    status: "running",
    startedAt: new Date().toISOString(),
    progress: null,
  });

  const collector = registry.get(job.collector);
  if (!collector) {
    store.updateJob(jobId, {
      status: "failed",
      completedAt: new Date().toISOString(),
      progress: 1,
      error: {
        collector: job.collector,
        reason: "unavailable",
        message: `Collector "${job.collector}" is not registered.`,
      },
    });
    return;
  }

  let timedOut = false;
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error(`Job timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    const outcome = await Promise.race([collector.execute(job.target), timeout]);
    clearTimeout(timer!);
    const result = collector.normalize(outcome);
    store.setResult(jobId, {
      entities: result.entities,
      relationships: result.relationships,
      evidence: result.evidence,
      warnings: result.warnings,
      errors: result.errors,
    });
    if (store.getJob(jobId)?.status === "cancelled") return; // discard: see file header on cancellation
    store.updateJob(jobId, {
      status: outcome.execution.status,
      completedAt: outcome.execution.completedAt,
      resultCount: outcome.execution.resultCount,
      error: outcome.execution.error,
      progress: 1,
    });
  } catch (err) {
    clearTimeout(timer!);
    if (store.getJob(jobId)?.status === "cancelled") return;
    const message = err instanceof Error ? err.message : String(err);
    store.updateJob(jobId, {
      status: "failed",
      completedAt: new Date().toISOString(),
      progress: 1,
      error: { collector: job.collector, reason: timedOut ? "timeout" : "unknown", message },
    });
  }
}

export interface StartedInvestigation {
  investigationId: string;
  plan: OsintPlan;
  jobs: InvestigationJob[];
}

/**
 * Plans the investigation, creates one job per selected collector, and
 * starts them all — fires each `runJob()` without awaiting it, so this
 * function itself returns as soon as the jobs exist (§12: "must not run
 * inside a normal browser request for an extended period").
 *
 * `collectorIds`, when given, restricts execution to that subset of
 * `plan.collectors` — plan §31 P2 "Recon collector selection." `plan`
 * itself (returned in `StartedInvestigation`) always reports every
 * candidate the query planner found, filtered or not, so a caller can tell
 * "not offered" apart from "offered but deselected." An id that doesn't
 * match any planned collector is silently ignored rather than erroring —
 * the UI builds this list from the same plan it's filtering, so a mismatch
 * would only happen from a stale client state, not a real target/collector
 * disagreement worth failing loudly over.
 */
export function startInvestigation(
  rawInput: string,
  registry: CollectorRegistry = collectorRegistry,
  store: JobStore = jobStore,
  timeoutMs: number = JOB_TIMEOUT_MS,
  collectorIds?: readonly string[],
): StartedInvestigation {
  const plan = planInvestigation(rawInput, registry);
  const selected = collectorIds
    ? plan.collectors.filter((pc) => collectorIds.includes(pc.collectorId))
    : plan.collectors;
  const investigationId = store.createInvestigation();
  const jobs = selected.map((pc) =>
    store.createJob(investigationId, pc.collectorId, { type: pc.targetType, value: plan.input }),
  );
  for (const job of jobs) {
    void runJob(job.id, registry, store, timeoutMs);
  }
  return { investigationId, plan, jobs };
}

/** True if the job was queued or running and is now marked cancelled; false if it doesn't exist or had already reached a terminal status. */
export function cancelJob(jobId: string, store: JobStore = jobStore): boolean {
  const job = store.getJob(jobId);
  if (!job || TERMINAL_STATUSES.includes(job.status)) return false;
  store.updateJob(jobId, {
    status: "cancelled",
    completedAt: new Date().toISOString(),
    progress: 1,
  });
  return true;
}

export interface InvestigationPoll {
  investigationId: string;
  jobs: InvestigationJob[];
  /** True once every job has reached a terminal status. */
  done: boolean;
  entities: CollectorEntity[];
  relationships: CollectorRelationship[];
  evidence: CollectorEvidence[];
  warnings: string[];
  errors: string[];
}

/** `GET /investigation/:id` per §12, as a plain function — `pollOsintInvestigationJob` below is the route-facing wrapper. Returns undefined for an unknown id rather than an empty poll, so a caller can't mistake "never existed" for "exists and found nothing." */
export function pollInvestigation(
  investigationId: string,
  store: JobStore = jobStore,
): InvestigationPoll | undefined {
  if (!store.hasInvestigation(investigationId)) return undefined;
  const jobs = store.getInvestigationJobs(investigationId);
  const done = jobs.every((j) => TERMINAL_STATUSES.includes(j.status));

  const results = jobs
    .map((j) => store.getJobResult(j.id))
    .filter((r): r is JobResult => r !== undefined);

  return {
    investigationId,
    jobs,
    done,
    entities: dedupeEntitiesById(results.flatMap((r) => r.entities)),
    relationships: dedupeRelationships(results.flatMap((r) => r.relationships)),
    evidence: results.flatMap((r) => r.evidence),
    warnings: results.flatMap((r) => r.warnings),
    errors: results.flatMap((r) => r.errors),
  };
}

// ─── Browser-facing entry points — plan §31 P2 "Progress" / "Recon collector selection" ───

/**
 * `POST`-style plan preview — plan §31 P2 "Recon collector selection." Runs
 * the query planner (registering every collector first, same as the two
 * functions below) without starting anything, so the UI can show an
 * analyst which collectors a target would trigger and let them deselect
 * some before committing to `startOsintInvestigationJob`. Read-only: no
 * job, no investigation id, nothing enters `jobStore`.
 */
export const planOsintInvestigation = createServerFn({ method: "POST" })
  .validator((d: { target: string }) => d)
  .handler(async ({ data }) => {
    registerExistingCollectors();
    registerExternalCollectors();
    const plan = planInvestigation(data.target);
    return JSON.parse(JSON.stringify(plan));
  });

/**
 * `POST /investigation` per §12. Registers every collector (existing +
 * external) the same way `runOsintInvestigation` (`orchestrator.ts`) does,
 * then starts the job set and returns immediately — the caller polls
 * `pollOsintInvestigationJob` for live status rather than blocking on the
 * whole investigation the way `runOsintInvestigation` does.
 *
 * `collectorIds`, when supplied, restricts execution to that subset — see
 * `startInvestigation`'s own doc for the exact filtering semantics. Omit it
 * (or send every id `planOsintInvestigation` returned) to run everything
 * the planner found, matching the pre-selection-UI behavior.
 */
export const startOsintInvestigationJob = createServerFn({ method: "POST" })
  .validator((d: { target: string; collectorIds?: string[] }) => d)
  .handler(async ({ data }) => {
    registerExistingCollectors();
    registerExternalCollectors();
    const started = startInvestigation(
      data.target,
      collectorRegistry,
      jobStore,
      JOB_TIMEOUT_MS,
      data.collectorIds,
    );
    // See `orchestrator.ts`'s `runOsintInvestigation` for why this
    // round-trip exists: `unknown`-typed P0 contract fields (deliberately
    // conservative there) fail TanStack Start's serialization type-check
    // even though the runtime data is always plain JSON.
    return JSON.parse(JSON.stringify(started));
  });

/**
 * `GET /investigation/:id` per §12. Throws for an unknown investigation id
 * (matching Rule 5: the caller must be able to tell "this investigation
 * doesn't exist" apart from "it exists and found nothing" — collapsing
 * `pollInvestigation`'s `undefined` into an empty poll object here would
 * lose exactly that distinction).
 */
export const pollOsintInvestigationJob = createServerFn({ method: "GET" })
  .validator((d: { investigationId: string }) => d)
  .handler(async ({ data }) => {
    const poll = pollInvestigation(data.investigationId);
    if (!poll) {
      throw new Error(
        `No investigation found with id "${data.investigationId}" — it may have been lost to a server restart (job storage is in-memory by default; set JOB_STORE_PATH to persist it, see this file's header).`,
      );
    }
    return JSON.parse(JSON.stringify(poll));
  });
