/**
 * Case scoping for persisted snapshots (2026-08-30, ported from the teammate's fork).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE PROBLEM THIS EXISTS TO REMOVE.
 *
 * Before this, the graph and timeline snapshots were single-slot,
 * last-write-wins. Run case A, then case B, and `/graph` rendered B's data while
 * the analyst believed they were looking at A. Nothing errored. Nothing was
 * marked. The wrong data simply appeared — which is the worst failure mode this
 * project has, because it is indistinguishable from the right answer.
 *
 * Three changes fix it, and all three are needed:
 *
 *   1. **Provenance** — a snapshot records the case and run it came from.
 *   2. **Validation** — reading a snapshot for a case is a checked operation
 *      with three outcomes, not an assumption.
 *   3. **Per-case keys** — writing case B no longer destroys case A.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * UNSCOPED IS A REAL, LEGITIMATE STATE — NOT A DEFECT.
 *
 * `/recon` runs investigations outside any case. Those snapshots genuinely have
 * no `caseId`, and inventing one from "whatever case the UI has selected" would
 * be exactly the fabrication this project forbids: the currently-viewed case is
 * not provenance. So an unscoped snapshot is stored, kept, and reported as
 * **LEGACY / UNSCOPED** — never silently adopted by the case being viewed.
 *
 * Snapshots written before this land here too, correctly: they carry no case
 * metadata because none was recorded.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * CAPS ARE DISCLOSED, NOT SILENT.
 *
 * Measured: 582 bytes per entity, 1,124 per evidence record. A busy domain can
 * legitimately return thousands of entities, which projects to several MB for
 * ONE case — more than the whole ~5 MB origin quota. And every writer in this
 * codebase swallows quota errors silently, so an over-quota write would vanish
 * and leave the PREVIOUS snapshot on screen: silent wrong data again, by a
 * different route.
 *
 * So snapshots are capped, the cap is recorded in the snapshot itself
 * (`truncated`, `totalRecords`), and the UI renders it. A capped snapshot must
 * never read as a complete one.
 */

// ─── Provenance ─────────────────────────────────────────────────────────────

/**
 * Where a snapshot came from.
 *
 * `caseId` and `runId` are `string | null` rather than optional: null states
 * plainly "written outside a case", which is different from a field nobody
 * thought about. Both are absent entirely on pre-case-scoping snapshots, which
 * is how `assertSnapshotBelongsToCase()` recognises legacy data.
 */
export interface SnapshotProvenance {
  /** The case this belongs to, or null when written outside one (e.g. from /recon). */
  caseId: string | null;
  /** The CaseRun that produced it, or null. */
  runId: string | null;
  /** The OSINT job-system investigation id. Always present — a snapshot always came from a run. */
  investigationId: string;
  target: string;
  /** ISO 8601. Kept as `savedAt` for backwards compatibility with existing snapshots. */
  savedAt: string;
}

/** Recorded when a snapshot was capped, so a truncated view cannot read as a complete one. */
export interface SnapshotTruncation {
  truncated: boolean;
  /** How many records the run actually produced, before capping. */
  totalRecords: number;
  /** How many were stored. */
  storedRecords: number;
}

// ─── Caps and eviction — derived from the measurements ──────────────────────

/** ≈291 KB at 582 B/entity. */
export const MAX_SNAPSHOT_ENTITIES = 500;
/** ≈337 KB at 1,124 B/evidence. */
export const MAX_SNAPSHOT_EVIDENCE = 300;
/** Relationships are cheap but unbounded in principle; capped proportionally. */
export const MAX_SNAPSHOT_RELATIONSHIPS = 1000;
/** 5 × ≈628 KB ≈ 3.1 MB worst case, leaving headroom under a ~5 MB quota. */
export const MAX_SCOPED_CASES = 5;

/** Caps a list and reports what it did. Never silently drops. */
export function capRecords<T>(records: readonly T[], max: number): { kept: T[]; truncation: SnapshotTruncation } {
  const kept = records.length > max ? records.slice(0, max) : [...records];
  return {
    kept,
    truncation: {
      truncated: records.length > max,
      totalRecords: records.length,
      storedRecords: kept.length,
    },
  };
}

// ─── Validation ──────────────────────────────────────────────────────────────

/**
 * The three outcomes of asking "does this snapshot belong to this case?".
 *
 * `UNSCOPED` is deliberately NOT folded into `MISMATCH`: one means "this came
 * from somewhere else and showing it here would be wrong", the other means "this
 * has no case attached and we must not assume". They need different words on
 * screen because they need different responses from the analyst.
 */
export type CaseScopeResult = "MATCH" | "MISMATCH" | "UNSCOPED";

export interface CaseScopeVerdict {
  result: CaseScopeResult;
  /** Rendered verbatim. An unexplained rejection is not actionable. */
  detail: string;
  /** The case the snapshot actually belongs to, when it names one. */
  snapshotCaseId: string | null;
}

/** Anything carrying optional case provenance. Structural, so no store imports this module's callers. */
export interface MaybeScoped {
  caseId?: string | null;
  runId?: string | null;
  target?: string;
  savedAt?: string;
}

/**
 * True when a snapshot carries no case provenance at all — either written
 * outside a case (`null`) or predating case scoping (`undefined`).
 *
 * Deliberately NOT a three-way classifier: deciding MATCH vs MISMATCH needs the
 * case being viewed, so that question only has an answer through
 * `assertSnapshotBelongsToCase`. A one-argument version could only ever return
 * UNSCOPED, which would be a function that looks useful and tells you nothing.
 */
export function isUnscoped(snapshot: MaybeScoped | null | undefined): boolean {
  return !snapshot || snapshot.caseId === undefined || snapshot.caseId === null;
}

/**
 * The gate. Never returns a boolean — the caller must handle all three states.
 *
 * A MISMATCH is surfaced, not silently swallowed and not silently rendered.
 */
export function assertSnapshotBelongsToCase(
  snapshot: MaybeScoped | null | undefined,
  caseId: string,
): CaseScopeVerdict {
  if (!snapshot) {
    return { result: "UNSCOPED", detail: "No snapshot is stored.", snapshotCaseId: null };
  }

  const snapshotCaseId = snapshot.caseId ?? null;

  if (snapshotCaseId === null) {
    return {
      result: "UNSCOPED",
      detail:
        snapshot.caseId === undefined
          ? "This snapshot predates case scoping and carries no case provenance. It is shown as LEGACY / UNSCOPED and is NOT treated as belonging to this case."
          : "This snapshot was produced outside a case (for example from Recon). It carries no case provenance and is NOT treated as belonging to this case.",
      snapshotCaseId: null,
    };
  }

  if (snapshotCaseId !== caseId) {
    return {
      result: "MISMATCH",
      detail: `This snapshot belongs to case ${snapshotCaseId}, not ${caseId}. It is not shown as this case's data.`,
      snapshotCaseId,
    };
  }

  return {
    result: "MATCH",
    detail: `Snapshot belongs to case ${caseId}${snapshot.target ? ` (${snapshot.target})` : ""}.`,
    snapshotCaseId,
  };
}

// ─── Per-case keys and eviction ──────────────────────────────────────────────

/**
 * Case-scoped storage key.
 *
 * The unsuffixed key is retained as the UNSCOPED slot, so `/recon`'s existing
 * hand-off keeps working unchanged and pre-case-scoping data is still readable.
 */
export function scopedKey(baseKey: string, caseId: string | null | undefined): string {
  return caseId ? `${baseKey}__${caseId}` : baseKey;
}

/** Case ids that currently hold a snapshot under `baseKey`, newest write first. */
export function listScopedCases(baseKey: string): string[] {
  if (typeof window === "undefined") return [];
  const prefix = `${baseKey}__`;
  const found: { caseId: string; savedAt: string }[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !key.startsWith(prefix)) continue;
      const caseId = key.slice(prefix.length);
      let savedAt = "";
      try {
        savedAt = JSON.parse(localStorage.getItem(key) || "{}")?.savedAt ?? "";
      } catch {
        // Unparseable entry: keep it in the list with no date so eviction can
        // still reach it, rather than leaving it permanently unreclaimable.
      }
      found.push({ caseId, savedAt });
    }
  } catch {
    return [];
  }
  return found.sort((a, b) => b.savedAt.localeCompare(a.savedAt)).map((f) => f.caseId);
}

/**
 * Drops the oldest case snapshots beyond `MAX_SCOPED_CASES`.
 *
 * Returns the evicted case ids so a caller can report them. Silent eviction
 * would recreate the problem this module is closing — an analyst returning to an
 * old case must be told its snapshot is gone, not shown nothing and left to
 * assume the run found nothing.
 */
export function evictOldScopedCases(baseKey: string, keep: number = MAX_SCOPED_CASES): string[] {
  if (typeof window === "undefined") return [];
  const ordered = listScopedCases(baseKey);
  const evicted = ordered.slice(keep);
  const removed: string[] = [];
  for (const caseId of evicted) {
    try {
      localStorage.removeItem(scopedKey(baseKey, caseId));
      removed.push(caseId);
    } catch {
      // ignore — the next write will try again
    }
  }
  // Only keys actually removed are recorded. This is the ONLY writer of the
  // eviction ledger, which is what makes "EVICTED" a fact rather than an
  // inference from an absent key.
  recordEvictions(baseKey, removed);
  return removed;
}

/** Approximate bytes a value occupies, for the quota report. */
export function approximateBytes(value: unknown): number {
  try {
    return new Blob([typeof value === "string" ? value : JSON.stringify(value)]).size;
  } catch {
    // Blob is unavailable in some test environments; UTF-16 length is a usable
    // upper bound and is only ever used for reporting.
    return String(typeof value === "string" ? value : JSON.stringify(value)).length * 2;
  }
}

export interface StorageReport {
  totalBytes: number;
  byKey: Record<string, number>;
  scopedCases: number;
  /** Rough share of a ~5 MB origin quota. */
  percentOfQuota: number;
}

export const ASSUMED_QUOTA_BYTES = 5 * 1024 * 1024;

export function storageReport(): StorageReport {
  const byKey: Record<string, number> = {};
  let totalBytes = 0;
  if (typeof window === "undefined") {
    return { totalBytes: 0, byKey, scopedCases: 0, percentOfQuota: 0 };
  }
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;
      const bytes = approximateBytes(key + (localStorage.getItem(key) ?? ""));
      byKey[key] = bytes;
      totalBytes += bytes;
    }
  } catch {
    // Storage unreadable (private mode). Report zero rather than throwing.
  }
  return {
    totalBytes,
    byKey,
    scopedCases: new Set([
      ...listScopedCases("sentinel_graph_snapshot"),
      ...listScopedCases("sentinel_timeline_snapshot"),
    ]).size,
    percentOfQuota: Math.round((totalBytes / ASSUMED_QUOTA_BYTES) * 1000) / 10,
  };
}

// ─── Eviction ledger ─────────────────────────────────────────────────────────

/**
 * WHY THIS EXISTS.
 *
 * Eviction removes a case's snapshot key. After that, an evicted case and a case
 * that never ran look **identical** to every reader: both simply have no key. So
 * the selector said "(no snapshot)" for both, and an analyst returning to an old
 * case could not tell "this run found nothing" from "this run's results were
 * discarded to make room". Those call for opposite responses — the first is a
 * finding, the second is a re-run.
 *
 * The fix is a ledger of what was **actually evicted**, written at the moment
 * the storage layer removes a key.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT THIS IS NOT.
 *
 * - **Not a snapshot.** No graph or timeline data is retained, invented or
 *   reconstructed. The ledger holds an id and a timestamp; the evidence is gone
 *   and the UI says so.
 * - **Not an inference.** Absence of a snapshot never marks a case EVICTED. Only
 *   `evictOldScopedCases()` writes here, and only for keys it actually removed.
 *   A case that never ran stays NO_SNAPSHOT forever.
 * - **Not a deletion record.** The case itself is untouched and still exists.
 * - **Not unbounded.** Capped at `MAX_EVICTION_HISTORY`, oldest first — a ledger
 *   that grows without limit would eventually cause the quota pressure it exists
 *   to explain.
 */

/** One real eviction. Fields are facts, not estimates. */
export interface EvictionRecord {
  /** Which store — `sentinel_graph_snapshot` or `sentinel_timeline_snapshot`. */
  baseKey: string;
  caseId: string;
  /** ISO 8601, stamped when the removal actually happened. */
  evictedAt: string;
}

export const EVICTION_KEY = "sentinel_snapshot_evictions";

/**
 * Deliberately larger than `MAX_SCOPED_CASES` (5) but still small.
 *
 * The ledger must outlive the snapshots it describes — that is its whole
 * purpose — so bounding it at 5 would discard the record of the very case the
 * analyst is asking about. 20 entries covers both stores across a long session
 * at roughly 100 bytes each, i.e. ~2 KB against a ~5 MB quota.
 */
export const MAX_EVICTION_HISTORY = 20;

export function getEvictions(): EvictionRecord[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(EVICTION_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Drop malformed rows rather than repairing them — a half-known eviction
    // record would assert something nobody measured.
    return parsed.filter(
      (r): r is EvictionRecord =>
        !!r && typeof r.baseKey === "string" && typeof r.caseId === "string" && typeof r.evictedAt === "string",
    );
  } catch {
    return [];
  }
}

function writeEvictions(list: EvictionRecord[]): void {
  try {
    localStorage.setItem(EVICTION_KEY, JSON.stringify(list));
  } catch {
    // Quota or private-mode failure. The eviction still happened; only the
    // explanation is lost, and the case then reads NO_SNAPSHOT — understating
    // what we know rather than overstating it.
  }
}

/**
 * Records real evictions. Called by `evictOldScopedCases`, nowhere else.
 *
 * `at` is injectable so tests are deterministic. It defaults to now because
 * this stamps an event that IS happening now — unlike the forbidden
 * `x || new Date()` pattern, which stamps now onto a record whose real time was
 * never known.
 */
export function recordEvictions(
  baseKey: string,
  caseIds: readonly string[],
  at: string = new Date().toISOString(),
): EvictionRecord[] {
  if (typeof window === "undefined" || caseIds.length === 0) return [];
  const added = caseIds.map((caseId) => ({ baseKey, caseId, evictedAt: at }));
  // Newest first, one row per (store, case): a case evicted twice is still one
  // fact — "your snapshot is gone" — and the latest time is the true one.
  const merged = [
    ...added,
    ...getEvictions().filter((r) => !(r.baseKey === baseKey && caseIds.includes(r.caseId))),
  ].slice(0, MAX_EVICTION_HISTORY);
  writeEvictions(merged);
  return added;
}

/**
 * Clears a case's eviction record for one store.
 *
 * Called when that case writes a fresh snapshot: the data is back, so the
 * explanation for its absence is no longer true and must not linger.
 */
export function clearEviction(baseKey: string, caseId: string): void {
  if (typeof window === "undefined" || !caseId) return;
  const before = getEvictions();
  const after = before.filter((r) => !(r.baseKey === baseKey && r.caseId === caseId));
  if (after.length !== before.length) writeEvictions(after);
}

/** The eviction record for a case in one store, or null. */
export function evictionFor(baseKey: string, caseId: string): EvictionRecord | null {
  if (!caseId) return null;
  return getEvictions().find((r) => r.baseKey === baseKey && r.caseId === caseId) ?? null;
}

/** Case ids evicted from one store, newest first. */
export function evictedCaseIds(baseKey: string): string[] {
  return getEvictions()
    .filter((r) => r.baseKey === baseKey)
    .map((r) => r.caseId);
}

/**
 * Why a case has no snapshot to show.
 *
 * `HAS_SNAPSHOT` wins over any ledger row, so a stale record can never hide real
 * data — belt and braces alongside `clearEviction` on write.
 */
export type CaseSnapshotState = "HAS_SNAPSHOT" | "EVICTED" | "NO_SNAPSHOT";

export function caseSnapshotState(
  caseId: string,
  scopedCaseIds: readonly string[],
  evicted: readonly string[],
): CaseSnapshotState {
  if (scopedCaseIds.includes(caseId)) return "HAS_SNAPSHOT";
  if (evicted.includes(caseId)) return "EVICTED";
  // Absence alone is never eviction. A case that never ran stays here.
  return "NO_SNAPSHOT";
}

/** Shown wherever an evicted case is selected. States the cause, claims nothing else. */
export const EVICTED_MESSAGE = "Snapshot was evicted due to local storage limits.";

export const SCOPE_CAVEATS: string[] = [
  "A snapshot is shown for a case only when it records that case's id. Anything else is labelled rather than displayed as this case's data.",
  "Investigations run from Recon are not case-scoped. Their snapshots are kept and labelled LEGACY / UNSCOPED — the currently-viewed case is not evidence of where data came from.",
  `Snapshots are capped at ${MAX_SNAPSHOT_ENTITIES} entities and ${MAX_SNAPSHOT_EVIDENCE} evidence records, and the cap is stated wherever a capped snapshot is shown.`,
  `Snapshots are retained for the ${MAX_SCOPED_CASES} most recently run cases. Older ones are evicted, and their absence is reported rather than shown as an empty result.`,
];
