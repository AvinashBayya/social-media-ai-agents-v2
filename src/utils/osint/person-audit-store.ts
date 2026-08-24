/**
 * Append-only audit log for Person Investigation starts.
 *
 * Plain `node:fs` JSON-Lines append: one JSON object per line, loaded via a
 * dynamic `await import(...)` inside `auditStore()` in
 * `person-investigation.ts` (never a top-level `import` — that file is
 * reachable from client route components via `osint/orchestrator.ts`/
 * `osint/jobs.ts`, and a static import here would pull `node:fs` into the
 * client bundle).
 *
 * The first working version used `bun:sqlite`, matching
 * `job-store-sqlite.ts`'s established precedent for the identical
 * client-bundle-leak problem. That approach failed for a deeper reason,
 * verified live 2026-08-19: this project's current Vite/Nitro dev server
 * runs `createServerFn` handlers through a module loader that rejects the
 * `bun:` protocol outright ("Only URLs with a scheme in: file, data, and
 * node are supported by the default ESM loader. Received protocol
 * 'bun:'"), even though the overall process is started with `bun run dev`.
 * `bun:sqlite` is not usable from inside a real server function in this
 * environment at all — `job-store-sqlite.ts`'s own `SqliteJobStore` would
 * hit this identically the moment `JOB_STORE_PATH` was ever actually set
 * (it has not been, in any verification run this session — flagged, not
 * fixed, since that file is existing code outside this task's scope).
 * `node:fs`/`node:path` are standard Node built-ins the same loader handles
 * without issue, confirmed live.
 *
 * Append-only by design: `append()` writes, never rewrites or deletes — a
 * lawful-basis audit trail that could be silently edited after the fact
 * would not be an audit trail. There is no `deleteEntry`/`updateEntry`
 * method anywhere in this file.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { PersonInvestigationAuditEntry } from "./person-investigation";

export class PersonAuditStore {
  private readonly path: string;
  private readonly memoryEntries: PersonInvestigationAuditEntry[] | null;

  /** `path` may be a real file path or `:memory:` (used by this file's own tests). */
  constructor(path: string) {
    this.path = path;
    this.memoryEntries = path === ":memory:" ? [] : null;
    if (this.memoryEntries === null) {
      const dir = dirname(path);
      if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
  }

  append(entry: PersonInvestigationAuditEntry): void {
    if (this.memoryEntries) {
      this.memoryEntries.push(entry);
      return;
    }
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`, "utf8");
  }

  /** Every entry, oldest first. For the report view and for tests — never used to mutate. */
  readAll(): PersonInvestigationAuditEntry[] {
    if (this.memoryEntries) return [...this.memoryEntries];
    if (!existsSync(this.path)) return [];
    const raw = readFileSync(this.path, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as PersonInvestigationAuditEntry);
  }

  /** Every entry for one case, oldest first. */
  readForCase(caseRef: string): PersonInvestigationAuditEntry[] {
    return this.readAll().filter((e) => e.caseRef === caseRef);
  }

  /** Not part of any shared interface — kept for API parity with other stores in this
   * codebase; a no-op here since a plain file append never holds an open handle between calls. */
  close(): void {
    // no-op
  }
}
