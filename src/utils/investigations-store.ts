import { localId } from "./local-id";
import { bandFor } from "./credibility";
import type { ContributingModule, SourceRef } from "./reports";

/**
 * Investigation case workspaces.
 *
 * This was a shell around seeded fiction. Two demonstration cases shipped with
 * invented risk scores (78, 88), invented threat scores (82, 90), analyst names
 * nobody had assigned, and hand-written evidence entries — "Coordinated cluster
 * identified — 4 accounts, 90s window", "EXIF corroborates capture time;
 * geolocation within 200m" — describing analysis that had never been run. New
 * cases were created with `risk: 50, threatScore: 50`, two more numbers nothing
 * computed.
 *
 * Worse, the mechanism that would have made a case real — PinButton — existed
 * but was wired into NOTHING. There were zero call sites, so no evidence could
 * ever be added and the seeded entries were all a case could ever contain.
 *
 * The rebuild: cases start empty, evidence is pinned from the modules with its
 * real provenance attached, and every case-level figure is DERIVED from that
 * evidence or reported as absent. An investigation is now a curated source set,
 * which is exactly what Module 5 needs to generate a product from.
 */

/** Which module an item was pinned from. Carried so it can become a SourceRef. */
export type EvidenceKind = "news" | "social" | "image" | "geo" | "note";

export interface PinnedEvidence {
  id: string;
  /** ISO 8601 — when it was pinned. The old `t` was "09:42" with no date. */
  pinnedAt: string;
  kind: EvidenceKind;
  /** Headline, post text, or filename. */
  title: string;
  /** Outlet, account handle, or capture device. */
  source: string;
  url: string;
  /** ISO 8601 publication/capture time as reported upstream, when known. */
  publishedAt: string;
  /** Analyst's own note. Never auto-generated. */
  note: string;
  /** Module 1 score 0-1, when the item came from a scored corpus. */
  credibility: number | null;
  credibilityRationale: string;
  /** Text handed to the model when this case generates a product. */
  excerpt: string;
  /** Anything else the source module carried, for display. */
  data?: any;
}

export interface Investigation {
  id: string;
  target: string;
  title: string;
  description: string;
  status: "Active" | "Triage" | "Watch" | "Closed";
  /** Free text the analyst sets. No default name is invented. */
  owner: string;
  keywords: string[];
  evidence: PinnedEvidence[];
  notes: string;
  createdAt: string;
}

const STORE_KEY = "sentinel_investigations";
/**
 * Bumped when the shape changes. The old key held two seeded cases with invented
 * risk scores; without a version check they would survive in every browser that
 * had already loaded the page and keep rendering fabricated figures.
 */
const STORE_VERSION_KEY = "sentinel_investigations_version";
const STORE_VERSION = "2";

export function getInvestigations(): Investigation[] {
  if (typeof window === "undefined") return [];
  try {
    if (localStorage.getItem(STORE_VERSION_KEY) !== STORE_VERSION) {
      // Drop v1 data outright. It contained only seeded fiction, so there is
      // nothing to migrate — and migrating invented scores forward would be
      // worse than losing them.
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

export function saveInvestigations(list: Investigation[]): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(list));
    localStorage.setItem(STORE_VERSION_KEY, STORE_VERSION);
  } catch {
    /* quota — caller's in-memory list is unaffected */
  }
}

export function createInvestigation(
  target: string,
  title: string,
  description: string,
  keywords: string[] = [],
  owner = "",
): Investigation {
  const list = getInvestigations();
  const used = list
    .map((c) => Number.parseInt(c.id.split("-")[1] ?? "", 10))
    .filter((n) => Number.isFinite(n));
  const nextNum = used.length > 0 ? Math.max(...used) + 1 : 1001;

  const newCase: Investigation = {
    id: `INV-${nextNum}`,
    target: target.trim() || "Unnamed subject",
    title: title.trim() || `${target.trim() || "Unnamed subject"} investigation`,
    description: description.trim(),
    status: "Active",
    // No "Unassigned" placeholder masquerading as an identity. There is no auth,
    // so an owner is only ever what the analyst typed.
    owner: owner.trim(),
    keywords,
    evidence: [],
    notes: "",
    createdAt: new Date().toISOString(),
  };

  list.unshift(newCase);
  saveInvestigations(list);
  return newCase;
}

export function deleteInvestigation(caseId: string): void {
  saveInvestigations(getInvestigations().filter((c) => c.id !== caseId));
}

export interface PinInput {
  kind: EvidenceKind;
  title: string;
  source: string;
  url?: string;
  publishedAt?: string;
  note?: string;
  credibility?: number | null;
  credibilityRationale?: string;
  excerpt?: string;
  data?: any;
}

export function pinToInvestigation(caseId: string, input: PinInput): boolean {
  const list = getInvestigations();
  const idx = list.findIndex((c) => c.id === caseId);
  if (idx === -1) return false;

  // Same URL pinned twice to one case is a duplicate, not two pieces of
  // evidence. Counting it twice would inflate every derived figure below.
  if (input.url && list[idx].evidence.some((e) => e.url && e.url === input.url)) return false;

  list[idx].evidence.unshift({
    id: localId("ev"),
    pinnedAt: new Date().toISOString(),
    kind: input.kind,
    title: input.title,
    source: input.source,
    url: input.url ?? "",
    publishedAt: input.publishedAt ?? "",
    note: input.note ?? "",
    credibility: input.credibility ?? null,
    credibilityRationale:
      input.credibilityRationale ?? "No credibility score was carried with this item.",
    excerpt: input.excerpt ?? input.title,
    data: input.data,
  });

  saveInvestigations(list);
  return true;
}

export function removeEvidence(caseId: string, evidenceId: string): void {
  const list = getInvestigations();
  const idx = list.findIndex((c) => c.id === caseId);
  if (idx === -1) return;
  list[idx].evidence = list[idx].evidence.filter((e) => e.id !== evidenceId);
  saveInvestigations(list);
}

export function updateAnalystNotes(caseId: string, notes: string): void {
  const list = getInvestigations();
  const idx = list.findIndex((c) => c.id === caseId);
  if (idx === -1) return;
  list[idx].notes = notes;
  saveInvestigations(list);
}

// ─── Derived case metrics ──────────────────────────────────────────────────

export interface CaseMetrics {
  evidenceCount: number;
  /** Distinct outlets/accounts across the evidence. */
  distinctSources: number;
  byKind: Record<EvidenceKind, number>;
  /**
   * Mean Module 1 credibility across evidence that carries a score, 0-1, or
   * null when nothing pinned has one. NOT a risk score — there is no risk score.
   */
  meanCredibility: number | null;
  /** How many evidence items could be scored, of how many total. */
  scoredCount: number;
  /** Span of the evidence by publication date. */
  earliest: string | null;
  latest: string | null;
  /** One sentence an analyst can act on. */
  summary: string;
}

const EMPTY_KINDS: Record<EvidenceKind, number> = {
  news: 0, social: 0, image: 0, geo: 0, note: 0,
};

/**
 * Everything the case view displays, computed from the evidence.
 *
 * There is deliberately NO risk score and NO threat score. Nothing in this
 * system computes either, and the previous page rendered both as percentages
 * with progress bars, which reads as a measurement. What can be counted is
 * counted; what cannot is absent.
 */
export function caseMetrics(investigation: Investigation): CaseMetrics {
  const evidence = investigation.evidence ?? [];
  const byKind = { ...EMPTY_KINDS };
  for (const e of evidence) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;

  const scored = evidence.map((e) => e.credibility).filter((c): c is number => c !== null);
  const meanCredibility = scored.length
    ? scored.reduce((a, b) => a + b, 0) / scored.length
    : null;

  const dates = evidence
    .map((e) => new Date(e.publishedAt).getTime())
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b);

  const distinctSources = new Set(evidence.map((e) => e.source).filter(Boolean)).size;

  let summary: string;
  if (evidence.length === 0) {
    summary =
      "No evidence pinned. Pin items from News, Social or Image Intelligence to build the " +
      "case — a case with no evidence supports no findings.";
  } else {
    const credPart =
      meanCredibility === null
        ? "none of it carries a credibility score"
        : `mean source credibility ${(meanCredibility * 100).toFixed(0)}% ` +
          `(${bandFor(meanCredibility).label}) across ${scored.length} of ${evidence.length} items`;
    summary =
      `${evidence.length} item(s) from ${distinctSources} distinct source(s); ${credPart}.` +
      (distinctSources === 1 && evidence.length > 1
        ? " All evidence comes from ONE source — nothing here is corroborated."
        : "");
  }

  return {
    evidenceCount: evidence.length,
    distinctSources,
    byKind,
    meanCredibility,
    scoredCount: scored.length,
    earliest: dates.length ? new Date(dates[0]).toISOString() : null,
    latest: dates.length ? new Date(dates[dates.length - 1]).toISOString() : null,
    summary,
  };
}

// ─── Bridge to Module 5 ────────────────────────────────────────────────────

const MODULE_FOR_KIND: Record<EvidenceKind, ContributingModule> = {
  news: "Module 1 · credibility",
  social: "Module 3 · social",
  image: "Module 4 · imagery",
  geo: "Module 5 · GIS",
  note: "Module 2 · content analysis",
};

/**
 * Pinned evidence as numbered, citable sources.
 *
 * This is what makes a case generate a real intelligence product: the evidence
 * the analyst curated becomes the ONLY material the model sees, and Module 5's
 * citation validation then guarantees every claim resolves back to one of these
 * items.
 */
export function sourcesFromEvidence(evidence: PinnedEvidence[]): SourceRef[] {
  return evidence.map((e, i) => ({
    n: i + 1,
    title: e.title,
    outlet: e.source,
    url: e.url,
    publishedAt: e.publishedAt,
    module: MODULE_FOR_KIND[e.kind] ?? "Module 2 · content analysis",
    credibility: e.credibility,
    credibilityRationale: e.credibilityRationale,
    // The analyst's own note is part of the record the model reasons over, and
    // is marked as such so it is never mistaken for reported source text.
    excerpt: e.note ? `${e.excerpt}\n\nAnalyst note: ${e.note}` : e.excerpt,
  }));
}
