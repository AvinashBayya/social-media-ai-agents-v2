import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteJobStore } from "../src/utils/osint/job-store-sqlite";

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sentinel-jobstore-test-"));
  dbPath = join(dir, "jobs.sqlite");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("SqliteJobStore — basic round trip", () => {
  test("createJob then getJob returns the same job", () => {
    const store = new SqliteJobStore(dbPath);
    const investigationId = store.createInvestigation();
    const job = store.createJob(investigationId, "dns", { type: "domain", value: "example.com" });
    const back = store.getJob(job.id);
    expect(back).toEqual(job);
    store.close();
  });

  test("getJob returns undefined for an unknown id", () => {
    const store = new SqliteJobStore(dbPath);
    expect(store.getJob("nonexistent")).toBeUndefined();
    store.close();
  });

  test("hasInvestigation is true for a created investigation and false otherwise", () => {
    const store = new SqliteJobStore(dbPath);
    const id = store.createInvestigation();
    expect(store.hasInvestigation(id)).toBe(true);
    expect(store.hasInvestigation("nonexistent")).toBe(false);
    store.close();
  });

  test("updateJob patches only the given fields, preserving the rest", () => {
    const store = new SqliteJobStore(dbPath);
    const investigationId = store.createInvestigation();
    const job = store.createJob(investigationId, "dns", { type: "domain", value: "example.com" });
    store.updateJob(job.id, { status: "running", startedAt: "2026-08-14T10:00:00.000Z" });
    const back = store.getJob(job.id);
    expect(back?.status).toBe("running");
    expect(back?.startedAt).toBe("2026-08-14T10:00:00.000Z");
    expect(back?.collector).toBe("dns"); // untouched field survives
    expect(back?.target).toEqual({ type: "domain", value: "example.com" }); // untouched field survives
    store.close();
  });

  test("updateJob on an unknown id is a silent no-op, matching InMemoryJobStore", () => {
    const store = new SqliteJobStore(dbPath);
    expect(() => store.updateJob("nonexistent", { status: "failed" })).not.toThrow();
    store.close();
  });

  test("getInvestigationJobs returns jobs in creation order", () => {
    const store = new SqliteJobStore(dbPath);
    const investigationId = store.createInvestigation();
    const a = store.createJob(investigationId, "dns", { type: "domain", value: "x" });
    const b = store.createJob(investigationId, "rdap", { type: "domain", value: "x" });
    const c = store.createJob(investigationId, "crtsh", { type: "domain", value: "x" });
    const jobs = store.getInvestigationJobs(investigationId);
    expect(jobs.map((j) => j.id)).toEqual([a.id, b.id, c.id]);
    store.close();
  });

  test("getInvestigationJobs for an unknown investigation is an empty array, not an error", () => {
    const store = new SqliteJobStore(dbPath);
    expect(store.getInvestigationJobs("nonexistent")).toEqual([]);
    store.close();
  });
});

describe("SqliteJobStore — honest nulls, never a fabricated default", () => {
  test("progress: null (running, no completion fraction) round-trips as null, not 0", () => {
    const store = new SqliteJobStore(dbPath);
    const investigationId = store.createInvestigation();
    const job = store.createJob(investigationId, "dns", { type: "domain", value: "x" });
    store.updateJob(job.id, { status: "running", progress: null });
    expect(store.getJob(job.id)?.progress).toBeNull();
    store.close();
  });

  test("error stays null until a job actually fails", () => {
    const store = new SqliteJobStore(dbPath);
    const investigationId = store.createInvestigation();
    const job = store.createJob(investigationId, "dns", { type: "domain", value: "x" });
    expect(store.getJob(job.id)?.error).toBeNull();
    store.close();
  });

  test("a real error object round-trips with its exact fields, not a placeholder", () => {
    const store = new SqliteJobStore(dbPath);
    const investigationId = store.createInvestigation();
    const job = store.createJob(investigationId, "dns", { type: "domain", value: "x" });
    store.updateJob(job.id, {
      status: "failed",
      error: { collector: "dns", reason: "timeout", message: "Job timed out after 60000ms" },
    });
    expect(store.getJob(job.id)?.error).toEqual({
      collector: "dns",
      reason: "timeout",
      message: "Job timed out after 60000ms",
    });
    store.close();
  });

  test("startedAt/completedAt stay null until explicitly set", () => {
    const store = new SqliteJobStore(dbPath);
    const investigationId = store.createInvestigation();
    const job = store.createJob(investigationId, "dns", { type: "domain", value: "x" });
    const back = store.getJob(job.id)!;
    expect(back.startedAt).toBeNull();
    expect(back.completedAt).toBeNull();
    store.close();
  });
});

describe("SqliteJobStore — job results", () => {
  test("setResult then getJobResult returns the exact same arrays", () => {
    const store = new SqliteJobStore(dbPath);
    const investigationId = store.createInvestigation();
    const job = store.createJob(investigationId, "dns", { type: "domain", value: "x" });
    const result = {
      entities: [
        {
          id: "dns:domain:x",
          type: "domain" as const,
          value: "x",
          displayName: "x",
          source: "dns",
          confidence: { value: null, reasons: [] },
          metadata: {},
        },
      ],
      relationships: [],
      evidence: [],
      warnings: ["something noted"],
      errors: [],
    };
    store.setResult(job.id, result);
    expect(store.getJobResult(job.id)).toEqual(result);
    store.close();
  });

  test("getJobResult returns undefined when no result has been set", () => {
    const store = new SqliteJobStore(dbPath);
    const investigationId = store.createInvestigation();
    const job = store.createJob(investigationId, "dns", { type: "domain", value: "x" });
    expect(store.getJobResult(job.id)).toBeUndefined();
    store.close();
  });

  test("setResult called twice for the same job overwrites rather than duplicating", () => {
    const store = new SqliteJobStore(dbPath);
    const investigationId = store.createInvestigation();
    const job = store.createJob(investigationId, "dns", { type: "domain", value: "x" });
    const empty = { entities: [], relationships: [], evidence: [], warnings: [], errors: [] };
    store.setResult(job.id, empty);
    store.setResult(job.id, { ...empty, warnings: ["updated"] });
    expect(store.getJobResult(job.id)?.warnings).toEqual(["updated"]);
    store.close();
  });
});

describe("SqliteJobStore — the actual point: persistence across instances", () => {
  test("data written by one instance is readable by a fresh instance pointed at the same file", () => {
    const first = new SqliteJobStore(dbPath);
    const investigationId = first.createInvestigation();
    const job = first.createJob(investigationId, "crtsh", { type: "domain", value: "github.com" });
    first.updateJob(job.id, {
      status: "completed",
      startedAt: "2026-08-14T10:00:00.000Z",
      completedAt: "2026-08-14T10:00:05.000Z",
      resultCount: 3,
    });
    first.setResult(job.id, {
      entities: [],
      relationships: [],
      evidence: [],
      warnings: [],
      errors: [],
    });
    first.close();

    // A brand new process would construct a fresh instance exactly like this
    // — this is what "survives a scale-to-zero cold start" actually means.
    const second = new SqliteJobStore(dbPath);
    expect(second.hasInvestigation(investigationId)).toBe(true);
    const jobs = second.getInvestigationJobs(investigationId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.status).toBe("completed");
    expect(jobs[0]!.resultCount).toBe(3);
    expect(second.getJobResult(job.id)).toEqual({
      entities: [],
      relationships: [],
      evidence: [],
      warnings: [],
      errors: [],
    });
    second.close();
  });

  test("creates its parent directory when it does not exist yet", () => {
    const nestedPath = join(dir, "nested", "deeper", "jobs.sqlite");
    const store = new SqliteJobStore(nestedPath);
    const id = store.createInvestigation();
    expect(store.hasInvestigation(id)).toBe(true);
    store.close();
  });
});
