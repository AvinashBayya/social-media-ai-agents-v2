/**
 * Person Investigation — feature flag, lawful-basis gate, mandatory audit
 * log, seed-entity construction, and fact classification.
 *
 * Deliberately does NOT introduce a second collector-orchestration stack:
 * every function here either gates/logs the *start* of an investigation, or
 * turns analyst-supplied form fields into the same `CollectorEntity` shape
 * `src/utils/collectors/result.ts` already defines, so `runInvestigation()`/
 * `resolveInvestigationEntities()`/`/graph` need no new code paths to accept
 * a Person investigation's output.
 *
 * See docs/PERSON-INVESTIGATION-ANALYSIS.md for the gap analysis this
 * implements against, and its "Assumptions & unknowns" §4/§6 for why the
 * audit log bridges into `investigations-store.ts`'s case-reference concept
 * rather than inventing a second case system, and why "shells to a tool"
 * (task's `presence.username`) follows theHarvester/SpiderFoot's
 * worker-over-HTTP precedent rather than an in-process subprocess.
 */

import { createServerFn } from "@tanstack/react-start";
import { collectorRegistry, type CollectorEntity, type ConfidenceScore } from "../collectors";

// ─── Feature flag ────────────────────────────────────────────────────────────

/**
 * Server-side gate for whether Person Investigation collectors register and
 * whether the UI panel offers the feature at all. Unset (the default) keeps
 * the feature fully off — matches `llm.ts`/`jobs.ts`'s "config, never code,
 * unset means off" convention exactly. This is a genuinely new capability
 * touching PII collection, so — unlike most collectors in this codebase,
 * which default to on — it defaults to OFF until explicitly enabled.
 */
export function personInvestigationEnabled(): boolean {
  return process.env.PERSON_INVESTIGATION_ENABLED === "true";
}

// ─── Seeds ───────────────────────────────────────────────────────────────────

// ─── Seeds ───────────────────────────────────────────────────────────────────

export interface PersonInvestigationSeeds {
  personName: string;
  aliases?: string[];
  age?: number;
  dateOfBirth?: string;
  city?: string;
  state?: string;
  country?: string;
  designation?: string;
  organization?: string;
  publicEmail?: string;
  publicPhone?: string;
  username?: string;
  knownSocialProfiles?: string[];
  website?: string;
  domain?: string;
}

/** True analyst input has at least a name — everything else is optional. */
export function validateSeeds(seeds: PersonInvestigationSeeds): string | null {
  if (!seeds.personName?.trim()) return "A person name is required to start an investigation.";
  return null;
}

const SEED_SOURCE = "analyst-seed";
/**
 * Not `UNSCORED` (`{ value: null, reasons: [] }`) — a seed is analyst-
 * supplied input, not an unmeasured fact, and the empty `reasons` array
 * would read identically to "we tried to measure this and couldn't." A
 * distinct reason string keeps the two cases distinguishable in the UI.
 */
const SEED_CONFIDENCE: ConfidenceScore = {
  value: null,
  reasons: ["Analyst-supplied seed value — not independently corroborated by any collector."],
};

/**
 * Turns the investigation form's fields into real `CollectorEntity` objects,
 * the same shape every existing collector already produces — so these seeds
 * flow straight into `runInvestigation()`'s dedup, `resolveInvestigationEntities()`'s
 * merge, and `/graph`'s renderer with zero special-casing.
 */
export function buildSeedEntities(seeds: PersonInvestigationSeeds): CollectorEntity[] {
  const name = seeds.personName.trim();
  const entities: CollectorEntity[] = [
    {
      id: `seed:person:${name.toLowerCase()}`,
      type: "person",
      value: name,
      displayName: name,
      source: SEED_SOURCE,
      confidence: SEED_CONFIDENCE,
      metadata: {
        ...(seeds.age ? { age: seeds.age } : {}),
        ...(seeds.dateOfBirth ? { dateOfBirth: seeds.dateOfBirth } : {}),
        // Was silently dropped: `designation` is a real form field
        // (PersonInvestigationSeeds, bound to the "Designation / Role"
        // input) but wasn't in fieldMappings below, so anything an analyst
        // typed there never reached an entity at all — not even an
        // unscored seed. There's no standalone "role" entity type in
        // result.ts's schema (a title describes a person, it isn't a
        // separately discoverable thing the way an org/domain/email is),
        // so it's carried as metadata on the person seed entity itself.
        ...(seeds.designation?.trim() ? { designation: seeds.designation.trim() } : {}),
      },
    },
  ];

  if (seeds.aliases && seeds.aliases.length > 0) {
    for (const alias of seeds.aliases) {
      if (!alias.trim()) continue;
      entities.push({
        id: `seed:alias:${alias.trim().toLowerCase()}`,
        type: "person",
        value: alias.trim(),
        displayName: `${alias.trim()} (alias of ${name})`,
        source: SEED_SOURCE,
        confidence: SEED_CONFIDENCE,
        metadata: { isAliasFor: name },
      });
    }
  }

  const fieldMappings: Array<[keyof PersonInvestigationSeeds, CollectorEntity["type"]]> = [
    ["publicEmail", "email"],
    ["username", "username"],
    ["publicPhone", "phone"],
    ["domain", "domain"],
    ["organization", "organization"],
    ["city", "location"],
    ["state", "location"],
    ["country", "location"],
    ["website", "url"],
  ];

  for (const [field, type] of fieldMappings) {
    const raw = seeds[field];
    if (typeof raw !== "string" || !raw.trim()) continue;
    const value = raw.trim();
    entities.push({
      id: `seed:${type}:${value.toLowerCase()}`,
      type,
      value,
      displayName: value,
      source: SEED_SOURCE,
      confidence: SEED_CONFIDENCE,
      metadata: {},
    });
  }

  if (seeds.knownSocialProfiles && seeds.knownSocialProfiles.length > 0) {
    for (const profile of seeds.knownSocialProfiles) {
      if (!profile.trim()) continue;
      entities.push({
        id: `seed:social_account:${profile.trim().toLowerCase()}`,
        type: "social_account",
        value: profile.trim(),
        displayName: `Possible public profile: ${profile.trim()}`,
        source: SEED_SOURCE,
        confidence: SEED_CONFIDENCE,
        metadata: {},
      });
    }
  }

  return entities;
}

/**
 * Extracts any domains present in an InvestigationResult to enable secondary
 * domain & infrastructure enrichment.
 */
export function extractDiscoveredDomains(entities: CollectorEntity[]): string[] {
  const domains = new Set<string>();
  for (const e of entities) {
    if (e.type === "domain" && e.value) {
      const clean = e.value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
      if (clean && !clean.includes(" ") && clean.includes(".")) {
        domains.add(clean);
      }
    }
  }
  return Array.from(domains);
}

// ─── Fact classification (task requirement #5) ──────────────────────────────

export type FactStatus = "Confirmed" | "Possible" | "Unknown";

/**
 * Directly on top of the confidence values `entity-resolution.ts`'s
 * `computeMergeConfidence()` already produces (0.65 at 2 corroborating
 * sources, 0.80 at 3, capped 0.95 at 4+) — a single-source fact is
 * `UNSCORED` (`value: null`) and lands in `Unknown`; two independent
 * sources clears this threshold into `Possible`; three or more into
 * `Confirmed`. No new confidence math — this only labels what already
 * exists, matching the task's "confidence only rises with independent
 * corroboration."
 */
export const CONFIRMED_THRESHOLD = 0.75;

export function classifyFact(confidence: ConfidenceScore): FactStatus {
  if (confidence.value === null) return "Unknown";
  return confidence.value >= CONFIRMED_THRESHOLD ? "Confirmed" : "Possible";
}

// ─── Lawful-basis gate + mandatory audit log ────────────────────────────────

export class LawfulBasisError extends Error {
  readonly field: "caseRef" | "lawfulBasisAttestation" | "investigator" | "seeds";
  constructor(field: "caseRef" | "lawfulBasisAttestation" | "investigator" | "seeds", message: string) {
    super(message);
    this.name = "LawfulBasisError";
    this.field = field;
  }
}

export interface StartPersonInvestigationInput {
  investigator: string;
  caseRef: string;
  lawfulBasisAttestation: string;
  seeds: PersonInvestigationSeeds;
}

export interface PersonInvestigationAuditEntry {
  investigator: string;
  caseRef: string;
  subjectSeeds: PersonInvestigationSeeds;
  startedAt: string;
  sources: string[];
}

/**
 * The gate itself. Throws `LawfulBasisError` naming the exact missing
 * field — never a generic "invalid input" — so the UI can point the
 * analyst at what to fill in rather than a blanket rejection.
 */
export function assertLawfulBasis(input: StartPersonInvestigationInput): void {
  if (!input.caseRef?.trim()) {
    throw new LawfulBasisError(
      "caseRef",
      "A case reference is required before a person investigation can start.",
    );
  }
  if (!input.lawfulBasisAttestation?.trim()) {
    throw new LawfulBasisError(
      "lawfulBasisAttestation",
      "A lawful-basis attestation is required before a person investigation can start — state " +
        "the specific lawful basis for collecting personal data on this subject.",
    );
  }
  if (!input.investigator?.trim()) {
    throw new LawfulBasisError(
      "investigator",
      "An investigator name is required before a person investigation can start.",
    );
  }
}

/**
 * Lazily loads the file-backed audit store (`person-audit-store.ts` — plain
 * `node:fs` JSON-Lines append, see that file's header for why it isn't
 * SQLite) via a dynamic `await import(...)`, never a top-level `import`.
 *
 * `jobs.ts`'s own `createJobStore()` uses `require()` for the equivalent
 * problem, on the stated reasoning that a dynamic `import()` can still be
 * discovered and bundled by Vite's static analyzer where `require()`
 * cannot. That reasoning does not hold in this project's *current* Vite/
 * Nitro version: verified live 2026-08-19 that `typeof require ===
 * "undefined"` inside an actual `createServerFn` handler in this dev
 * server — `require()` is not a real global here at all, so the
 * `jobs.ts`-style fix throws `ReferenceError: require is not defined` the
 * moment it's actually exercised (confirmed via a temporary diagnostic
 * server function, since `JOB_STORE_PATH` being unset by default meant
 * `jobs.ts`'s own `require()` path had never actually been exercised by any
 * previous live verification this session — every prior "no client crash"
 * check exercised the `InMemoryJobStore` branch instead). This may be a
 * latent, pre-existing issue in `jobs.ts` too if `JOB_STORE_PATH` is ever
 * set — flagged, not fixed here, since `jobs.ts` is existing, working
 * code as long as that variable stays unset, and changing it is outside
 * this task's scope.
 *
 * `await import(...)` is the standard, always-available ESM mechanism and
 * is what this runtime actually supports. Verified live (see
 * PROJECT_MEMORY.md) that it does NOT leak `bun:sqlite`/`node:fs`/
 * `node:path` into the client bundle here — every caller of this function
 * lives inside a `createServerFn` `.handler()` body (`startPersonInvestigation`
 * is only ever called from `startPersonInvestigationAudit`'s handler; the
 * handler bodies TanStack Start strips from the client bundle by design,
 * which is what actually keeps this out, not the import style itself).
 * `typeof window` is checked first regardless, as a second, independent
 * guard against ever reaching this client-side.
 */
let auditStoreSingleton: import("./person-audit-store").PersonAuditStore | null = null;
async function auditStore(): Promise<import("./person-audit-store").PersonAuditStore> {
  if (typeof window !== "undefined") {
    throw new Error("Person Investigation audit log is server-only and was reached client-side.");
  }
  if (!auditStoreSingleton) {
    const path = process.env.PERSON_AUDIT_LOG_PATH?.trim() || "data/person-investigation-audit.jsonl";
    const { PersonAuditStore } = await import("./person-audit-store");
    auditStoreSingleton = new PersonAuditStore(path);
  }
  return auditStoreSingleton;
}

/**
 * Test-only escape hatch to point the singleton at a fresh `:memory:`/temp
 * path between test cases, mirroring how `job-store-sqlite.test.ts` opens a
 * fresh store per test. Closes the outgoing store first — on Windows an
 * unclosed `bun:sqlite` handle keeps its file locked, and a test's own
 * `afterEach` deleting that directory would otherwise fail with EBUSY. Not
 * exported from `index.ts` — import directly.
 */
export function __resetAuditStoreForTests(): void {
  auditStoreSingleton?.close();
  auditStoreSingleton = null;
}

/**
 * The one function the UI/server function actually calls. Validates the
 * lawful-basis gate (throws, never silently proceeds), builds the audit
 * entry from real input (never `new Date()` substituting for a missing
 * timestamp — `startedAt` is always the real moment this function ran), and
 * appends it to the durable, append-only log before returning it.
 */
export async function startPersonInvestigation(
  input: StartPersonInvestigationInput,
  sources: string[],
): Promise<PersonInvestigationAuditEntry> {
  assertLawfulBasis(input);
  const seedError = validateSeeds(input.seeds);
  if (seedError) throw new LawfulBasisError("seeds", seedError);

  const entry: PersonInvestigationAuditEntry = {
    investigator: input.investigator.trim(),
    caseRef: input.caseRef.trim(),
    subjectSeeds: input.seeds,
    startedAt: new Date().toISOString(),
    sources,
  };
  const store = await auditStore();
  store.append(entry);
  return entry;
}

/** For the report view and for tests. Never used to mutate an entry. */
export async function readPersonInvestigationAudit(
  caseRef?: string,
): Promise<PersonInvestigationAuditEntry[]> {
  const store = await auditStore();
  return caseRef ? store.readForCase(caseRef) : store.readAll();
}

// ─── createServerFn wrappers ─────────────────────────────────────────────────
//
// `sources` is accepted from the caller rather than imported from
// `collectors/person` here — that module imports `personInvestigationEnabled`
// from THIS file, so importing it back would be a circular dependency. The
// UI already has the real planned collector ids from `planOsintInvestigation`
// by the time it calls this, which is more accurate anyway (what will
// actually run, not a static list).

export const personInvestigationStatus = createServerFn({ method: "GET" }).handler(async () => ({
  enabled: personInvestigationEnabled(),
}));

export interface StartPersonInvestigationResult {
  ok: boolean;
  entry?: PersonInvestigationAuditEntry;
  field?: "caseRef" | "lawfulBasisAttestation" | "investigator" | "seeds";
  message?: string;
}

export const startPersonInvestigationAudit = createServerFn({ method: "POST" })
  .validator((d: StartPersonInvestigationInput & { sources: string[] }) => d)
  .handler(async ({ data }): Promise<StartPersonInvestigationResult> => {
    try {
      const entry = await startPersonInvestigation(data, data.sources);
      return { ok: true, entry };
    } catch (err) {
      if (err instanceof LawfulBasisError) {
        return { ok: false, field: err.field, message: err.message };
      }
      throw err;
    }
  });

export const readPersonInvestigationAuditServer = createServerFn({ method: "GET" })
  .validator((d: { caseRef?: string } | undefined) => d)
  .handler(async ({ data }) => await readPersonInvestigationAudit(data?.caseRef));

// ─── Re-exported for callers that only need this file ───────────────────────

export { collectorRegistry };
