/// <reference types="bun" />
/**
 * SQLite-backed job store — OSINT-INTEGRATION-PLAN.md §16.
 *
 * The alternative `jobs.ts`'s own header names as still needed: "this needs
 * the same treatment plan §16 describes (SQLite for dev, PostgreSQL for
 * production) before a job could survive a scale-to-zero cold start between
 * `POST` and the next `GET`." This is that treatment for local/dev use —
 * `bun:sqlite` is a Bun built-in, so there is no new npm dependency, and it
 * satisfies the exact same `JobStore` interface `InMemoryJobStore`
 * (`job-store.ts`) does, so nothing in `jobs.ts` needs to know which one it
 * is talking to.
 *
 * Plan §16 also says not to migrate the whole application database at once
 * and to introduce persistence incrementally around the new investigation/
 * job subsystem specifically — this file does exactly that scope and no
 * more. It does not touch `investigations-store.ts`, `credential-vault.ts`,
 * or any other localStorage/file-backed state elsewhere in the app.
 *
 * Every complex field (`target`, `error`, and the four result arrays) is
 * stored as JSON text — SQLite has no native array/object column type, and
 * these values are already proven JSON-serializable at the point they enter
 * `JobStore` (the same P0 contract `runOsintInvestigation`'s
 * `JSON.parse(JSON.stringify(...))` round-trip already relies on). This is
 * genuinely a serialization round-trip, not a coercion: whatever was written
 * is read back structurally identical.
 *
 * PostgreSQL for production, per plan §16, is not attempted here — this
 * demo has no database service to point it at, and the free-tier constraint
 * that would need answering before adding one (`CLAUDE.md`'s "Free-tier
 * tooling only") is out of scope for this file.
 */

/**
 * `bun:sqlite` IS DELIBERATELY NOT IMPORTED AT MODULE SCOPE.
 *
 * A top-level `import { Database } from "bun:sqlite"` here is what made this
 * module unloadable on the production runtime. The image is `node:22-alpine`
 * running `node .output/server/index.mjs` (Dockerfile), and Node's ESM loader
 * throws ERR_UNSUPPORTED_ESM_URL_SCHEME on a `bun:` specifier — at LINK time,
 * before any guard in any caller can run. So every chunk that so much as
 * referenced this file took the whole server function down with it.
 *
 * That failure shipped three times, each via a different innocent import
 * elsewhere that re-chunked this module: once into the browser bundle, once via
 * `collector-health.ts` -> `gps-interference.ts`, and once via the OSINT
 * collector barrel. `jobs.ts` guarding the CALL was never enough, because the
 * cost is paid on IMPORT.
 *
 * The type is imported type-only (erased at build), and the value is resolved
 * at construction time through a specifier the bundler cannot constant-fold.
 * **Do not turn either of these back into a static import.**
 */
import type { Database as BunDatabase } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { CollectorErrorInfo } from "../collectors/errors";
import type { CollectorTarget } from "../collectors/types";
import type { InvestigationJob, JobResult, JobStatus, JobStore } from "./job-store";
import { nextId } from "./job-store";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS investigations (
  id TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  investigation_id TEXT NOT NULL,
  collector TEXT NOT NULL,
  target_json TEXT NOT NULL,
  status TEXT NOT NULL,
  progress REAL,
  started_at TEXT,
  completed_at TEXT,
  result_count INTEGER NOT NULL,
  error_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_investigation ON jobs (investigation_id);

CREATE TABLE IF NOT EXISTS job_results (
  job_id TEXT PRIMARY KEY,
  entities_json TEXT NOT NULL,
  relationships_json TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  warnings_json TEXT NOT NULL,
  errors_json TEXT NOT NULL
);
`;

interface JobRow {
  id: string;
  investigation_id: string;
  collector: string;
  target_json: string;
  status: string;
  progress: number | null;
  started_at: string | null;
  completed_at: string | null;
  result_count: number;
  error_json: string | null;
}

function rowToJob(row: JobRow): InvestigationJob {
  return {
    id: row.id,
    investigationId: row.investigation_id,
    collector: row.collector,
    target: JSON.parse(row.target_json) as CollectorTarget,
    status: row.status as JobStatus,
    progress: row.progress,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    resultCount: row.result_count,
    error: row.error_json ? (JSON.parse(row.error_json) as CollectorErrorInfo) : null,
  };
}

export class SqliteJobStore implements JobStore {
  private readonly db: BunDatabase;

  /** `path` may be a real file path or `:memory:` (used by this file's own tests). A file path's parent directory is created if missing. */
  constructor(path: string) {
    if (path !== ":memory:") {
      const dir = dirname(path);
      if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
    // Resolved here, not at module scope — see the note above the type import.
    // The specifier is built at runtime so it survives bundling unresolved.
    const bunSqlite = "bun:" + "sqlite";
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- a static import of bun:sqlite makes this module unloadable under Node; see the header note.
    const { Database } = require(bunSqlite) as typeof import("bun:sqlite");
    this.db = new Database(path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
  }

  createInvestigation(): string {
    const id = nextId("investigation");
    this.db.run("INSERT INTO investigations (id) VALUES (?)", [id]);
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
    this.db.run(
      `INSERT INTO jobs (id, investigation_id, collector, target_json, status, progress, started_at, completed_at, result_count, error_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        job.id,
        job.investigationId,
        job.collector,
        JSON.stringify(job.target),
        job.status,
        job.progress,
        job.startedAt,
        job.completedAt,
        job.resultCount,
        null,
      ],
    );
    return job;
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
    const existing = this.getJob(id);
    if (!existing) return;
    const merged: InvestigationJob = { ...existing, ...patch };
    this.db.run(
      `UPDATE jobs SET status = ?, progress = ?, started_at = ?, completed_at = ?, result_count = ?, error_json = ? WHERE id = ?`,
      [
        merged.status,
        merged.progress,
        merged.startedAt,
        merged.completedAt,
        merged.resultCount,
        merged.error ? JSON.stringify(merged.error) : null,
        id,
      ],
    );
  }

  setResult(id: string, result: JobResult): void {
    this.db.run(
      `INSERT INTO job_results (job_id, entities_json, relationships_json, evidence_json, warnings_json, errors_json)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(job_id) DO UPDATE SET
         entities_json = excluded.entities_json,
         relationships_json = excluded.relationships_json,
         evidence_json = excluded.evidence_json,
         warnings_json = excluded.warnings_json,
         errors_json = excluded.errors_json`,
      [
        id,
        JSON.stringify(result.entities),
        JSON.stringify(result.relationships),
        JSON.stringify(result.evidence),
        JSON.stringify(result.warnings),
        JSON.stringify(result.errors),
      ],
    );
  }

  getJob(id: string): InvestigationJob | undefined {
    const row = this.db.query("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | null;
    return row ? rowToJob(row) : undefined;
  }

  getJobResult(id: string): JobResult | undefined {
    const row = this.db.query("SELECT * FROM job_results WHERE job_id = ?").get(id) as {
      entities_json: string;
      relationships_json: string;
      evidence_json: string;
      warnings_json: string;
      errors_json: string;
    } | null;
    if (!row) return undefined;
    return {
      entities: JSON.parse(row.entities_json),
      relationships: JSON.parse(row.relationships_json),
      evidence: JSON.parse(row.evidence_json),
      warnings: JSON.parse(row.warnings_json),
      errors: JSON.parse(row.errors_json),
    };
  }

  hasInvestigation(investigationId: string): boolean {
    const row = this.db.query("SELECT id FROM investigations WHERE id = ?").get(investigationId);
    return row !== null;
  }

  getInvestigationJobs(investigationId: string): InvestigationJob[] {
    const rows = this.db
      .query("SELECT * FROM jobs WHERE investigation_id = ? ORDER BY rowid")
      .all(investigationId) as JobRow[];
    return rows.map(rowToJob);
  }

  /** Not part of `JobStore` — for tests and graceful shutdown only. */
  close(): void {
    this.db.close();
  }
}
