/**
 * Job store contract — OSINT-INTEGRATION-PLAN.md §12/§16.
 *
 * Extracted from `jobs.ts` (which used to define the store as one concrete
 * class) so a second, persistent implementation can exist alongside the
 * original in-memory one without touching any of `jobs.ts`'s own logic —
 * `startInvestigation`/`cancelJob`/`pollInvestigation`/`runJob` all already
 * depended only on this shape, never on `InMemoryJobStore`'s internals, so
 * turning that shape into an explicit interface changes nothing about how
 * they run. `jobs.ts` re-exports everything from here under its original
 * names (`JobStore`, `InvestigationJob`, `JobStatus`), so nothing importing
 * from `@/utils/osint/jobs` needs to change either.
 *
 * `InMemoryJobStore` here is byte-for-byte the same logic the old `JobStore`
 * class had — see `job-store-sqlite.ts` for the actual new capability plan
 * §16 asks for ("SQLite for dev, PostgreSQL for production... introduce
 * persistence incrementally around the new investigation/job subsystem").
 */

import type {
  CollectorEntity,
  CollectorEvidence,
  CollectorRelationship,
  ExecutionStatus,
} from "../collectors/result";
import type { CollectorErrorInfo } from "../collectors/errors";
import type { CollectorTarget } from "../collectors/types";

export type JobStatus = ExecutionStatus;

export interface InvestigationJob {
  id: string;
  investigationId: string;
  collector: string;
  target: CollectorTarget;
  status: JobStatus;
  /**
   * 0 before a job starts, 1 once it reaches any terminal status. `null`
   * while running: no P1 collector reports a real completion fraction, and
   * inventing one (a fake "0.5") would be exactly the fabricated-confidence
   * pattern this project forbids for every other measurement.
   */
  progress: number | null;
  startedAt: string | null;
  completedAt: string | null;
  resultCount: number;
  error: CollectorErrorInfo | null;
}

export interface JobResult {
  entities: CollectorEntity[];
  relationships: CollectorRelationship[];
  evidence: CollectorEvidence[];
  warnings: string[];
  errors: string[];
}

/**
 * What both the in-memory and SQLite stores implement, and what every
 * function in `jobs.ts` actually depends on. Any store swapped in behind
 * `createJobStore()` (`jobs.ts`) only needs to satisfy this.
 */
export interface JobStore {
  createInvestigation(): string;
  createJob(
    investigationId: string,
    collectorId: string,
    target: CollectorTarget,
  ): InvestigationJob;
  updateJob(
    id: string,
    patch: Partial<
      Pick<
        InvestigationJob,
        "status" | "progress" | "startedAt" | "completedAt" | "resultCount" | "error"
      >
    >,
  ): void;
  setResult(id: string, result: JobResult): void;
  getJob(id: string): InvestigationJob | undefined;
  getJobResult(id: string): JobResult | undefined;
  hasInvestigation(investigationId: string): boolean;
  getInvestigationJobs(investigationId: string): InvestigationJob[];
}

let counter = 0;
/** Shared by every store implementation so ids look the same regardless of backend. */
export function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`;
}

/**
 * In-memory job store — the original, unchanged behavior. Exported as a
 * class (mirroring `CollectorRegistry`) so tests can create an isolated
 * instance instead of sharing the global singleton — the same pattern
 * `registry: CollectorRegistry = collectorRegistry` uses throughout
 * `collectors/`. Lost on process restart; see `job-store-sqlite.ts` for the
 * alternative.
 */
export class InMemoryJobStore implements JobStore {
  private readonly jobs = new Map<string, InvestigationJob>();
  private readonly results = new Map<string, JobResult>();
  private readonly investigationJobs = new Map<string, string[]>();

  createInvestigation(): string {
    const id = nextId("investigation");
    this.investigationJobs.set(id, []);
    return id;
  }

  createJob(
    investigationId: string,
    collectorId: string,
    target: CollectorTarget,
  ): InvestigationJob {
    const job: InvestigationJob = {
      id: nextId("job"),
      investigationId,
      collector: collectorId,
      target,
      status: "queued",
      progress: 0,
      startedAt: null,
      completedAt: null,
      resultCount: 0,
      error: null,
    };
    this.jobs.set(job.id, job);
    const list = this.investigationJobs.get(investigationId);
    if (list) list.push(job.id);
    else this.investigationJobs.set(investigationId, [job.id]);
    return { ...job };
  }

  updateJob(
    id: string,
    patch: Partial<
      Pick<
        InvestigationJob,
        "status" | "progress" | "startedAt" | "completedAt" | "resultCount" | "error"
      >
    >,
  ): void {
    const job = this.jobs.get(id);
    if (!job) return;
    Object.assign(job, patch);
  }

  setResult(id: string, result: JobResult): void {
    this.results.set(id, result);
  }

  getJob(id: string): InvestigationJob | undefined {
    const job = this.jobs.get(id);
    return job ? { ...job } : undefined;
  }

  getJobResult(id: string): JobResult | undefined {
    return this.results.get(id);
  }

  hasInvestigation(investigationId: string): boolean {
    return this.investigationJobs.has(investigationId);
  }

  getInvestigationJobs(investigationId: string): InvestigationJob[] {
    const ids = this.investigationJobs.get(investigationId) ?? [];
    return ids
      .map((id) => this.jobs.get(id))
      .filter((j): j is InvestigationJob => j !== undefined)
      .map((j) => ({ ...j }));
  }
}
