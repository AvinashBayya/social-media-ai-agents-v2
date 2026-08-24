/**
 * The evidence vault store.
 *
 * `sentinel_evidence` had TWO owners writing two independently-declared shapes:
 * `routes/vault.tsx` (which inlined the key literal in three places) and
 * `components/manual-capture-panel.tsx`, whose own comment admitted it — "Local
 * mirror of vault.tsx's stored shape. Same key, same reader." That is exactly
 * the duplication `utils/evidence.ts` was extracted to prevent for hashing, and
 * it is how two writers end up disagreeing about what a record is.
 *
 * Two behaviours here are load-bearing:
 *
 *  1. **Seeded records are dropped, analyst uploads are kept.** The vault
 *     shipped three demonstration entries whose `caseId` values were `INV-2041`
 *     and `INV-2038` — ids `createInvestigation` can never mint, because it
 *     numbers from INV-1001 upward. Every one of them therefore rendered a bold
 *     blue case reference that resolved to nothing. The version guard removes
 *     them without touching anything an analyst actually uploaded.
 *
 *  2. **`pinnedEvidenceId` links the two stores.** A vault record that was
 *     pinned to a case has a copy inside that case's `evidence[]`. Deleting the
 *     vault record without removing that copy leaves the case citing an exhibit
 *     that no longer exists — and `sourcesFromEvidence` feeds those straight
 *     into Module 5's citation validator.
 */

export const EVIDENCE_KEY = "sentinel_evidence";

/**
 * Bumped when the shape changes. v2 drops the seeded demonstration records.
 * Unlike the investigations store, this MIGRATES rather than wipes: the same key
 * holds real analyst uploads and attested manual captures.
 */
const EVIDENCE_VERSION_KEY = "sentinel_evidence_version";
const EVIDENCE_VERSION = "2";

export interface EvidenceRecord {
  id: string;
  title: string;
  type: string;
  timestamp: string;
  source: string;
  /** Real SHA-256 of the file bytes; null for records with no file. */
  hash: string | null;
  /** Free-text location as the analyst entered it. Never a coordinate claim. */
  geo: string;
  entities: string[];
  caseId: string;
  /** Null when no analyst has rated this item. Never auto-generated. */
  risk: number | null;
  tags: string[];
  /** Null for manually-entered records where no file was supplied. */
  fileSize?: string | null;
  previewUrl?: string;
  /**
   * Id of the PinnedEvidence copy inside `caseId`, when one was created.
   *
   * Needed so unlinking or deleting here can remove the case's copy too.
   */
  pinnedEvidenceId?: string | null;
  /**
   * Legacy marker for the demonstration records seeded on first load.
   *
   * Kept on the type so v1 data can still be recognised and removed. Nothing
   * writes it any more.
   */
  seeded?: true;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Strip the seeded demonstration records, keep everything else.
 *
 * Exported so the migration is testable without a browser.
 */
export function withoutSeeded(raw: unknown): EvidenceRecord[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (e): e is EvidenceRecord => isRecord(e) && typeof e.id === "string" && e.seeded !== true,
  );
}

export function getEvidence(): EvidenceRecord[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(EVIDENCE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (window.localStorage.getItem(EVIDENCE_VERSION_KEY) !== EVIDENCE_VERSION) {
      const cleaned = withoutSeeded(parsed);
      window.localStorage.setItem(EVIDENCE_KEY, JSON.stringify(cleaned));
      window.localStorage.setItem(EVIDENCE_VERSION_KEY, EVIDENCE_VERSION);
      return cleaned;
    }
    return Array.isArray(parsed) ? (parsed as EvidenceRecord[]) : [];
  } catch {
    return [];
  }
}

export function saveEvidence(list: EvidenceRecord[]): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(EVIDENCE_KEY, JSON.stringify(list));
    window.localStorage.setItem(EVIDENCE_VERSION_KEY, EVIDENCE_VERSION);
  } catch {
    /* quota — the caller's in-memory list is unaffected */
  }
}

/**
 * Prepend one record.
 *
 * A corrupt store must not silently discard the analyst's new record, but it
 * also must not be overwritten wholesale — prepending to an empty list is the
 * least destructive option and the vault page will show the result.
 */
export function appendEvidence(item: EvidenceRecord): void {
  saveEvidence([item, ...getEvidence()]);
}

export function deleteEvidence(id: string): EvidenceRecord[] {
  const next = getEvidence().filter((e) => e.id !== id);
  saveEvidence(next);
  return next;
}

/** Set or clear the case link, and the id of the copy inside that case. */
export function setEvidenceCase(
  id: string,
  caseId: string,
  pinnedEvidenceId: string | null,
): EvidenceRecord[] {
  const next = getEvidence().map((e) => (e.id === id ? { ...e, caseId, pinnedEvidenceId } : e));
  saveEvidence(next);
  return next;
}

/**
 * Next free record id.
 *
 * The route computed this as `EVID-0${400 + list.length + 1}`, which reuses an
 * id as soon as anything is deleted — two different exhibits under one
 * identifier, in the one store whose whole purpose is identifying exhibits.
 */
export function nextEvidenceId(list: EvidenceRecord[]): string {
  const used = list
    .map((e) => Number.parseInt(String(e.id).replace(/^EVID-/, ""), 10))
    .filter((n) => Number.isFinite(n));
  const next = used.length > 0 ? Math.max(...used) + 1 : 401;
  return `EVID-${String(next).padStart(4, "0")}`;
}
