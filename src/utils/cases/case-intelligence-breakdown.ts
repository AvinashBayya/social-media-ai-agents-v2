import type { CollectorEntity, CollectorEvidence, CollectorRelationship } from "../collectors/result";
import { contributingSourcesOf } from "./case-entities";
import { MEDIAINT_NOT_CASE_SCOPED } from "./case-claims";

/**
 * Per-discipline breakdown of what a case actually holds (2026-08-30, ported
 * from the teammate's fork).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * IT COUNTS. IT DOES NOT CLASSIFY.
 *
 * Every collector already declares its own `disciplines`, and that declaration is
 * authoritative. This module never infers a discipline from a collector's name,
 * its output shape, or what "looks like" SOCMINT — it reads the declaration and
 * tallies. A collector with no declaration is reported as UNTAGGED, never filed
 * under a guess.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * NO SECOND EVIDENCE MODEL.
 *
 * The inputs are the case's existing stored snapshots — `CollectorEvidence[]`,
 * `CollectorEntity[]`, `CollectorRelationship[]` — plus counts already derived by
 * the existing claim/contradiction code. Nothing is stored, nothing is re-derived,
 * nothing is copied. This is a tally over data that already exists.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE THREE STATES, AND WHY "NOT CASE-SCOPED" IS NOT ZERO.
 *
 *   PRESENT          the case holds records for this discipline
 *   ZERO             the case was evaluated for it and produced none
 *   NOT_CASE_SCOPED  the capability exists but its output never reaches a case
 *
 * Collapsing the third into the second is the failure this module exists to
 * avoid. "GEOINT: 0" tells an analyst the case was searched for geospatial
 * intelligence and none was found. That would be false when the image-geolocation
 * component has written nothing to that case at all — the two statements demand
 * different responses and must not share a rendering.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * COUNTS OVERLAP AND DO NOT SUM.
 *
 * A collector may declare several disciplines: `wayback` is MEDIAINT **and**
 * TECHINT, `news` is MEDIAINT **and** GEOINT. One evidence record therefore
 * counts under every discipline its producing collector declares. The
 * per-discipline totals are consequently NOT a partition of the evidence set and
 * must never be summed or shown as percentages of a whole. `TOTALS_OVERLAP` says
 * so wherever this renders.
 */

export const DISCIPLINES = ["SOCMINT", "TECHINT", "GEOINT", "MEDIAINT"] as const;
export type DisciplineKey = (typeof DISCIPLINES)[number];

/** Where a metric could not be counted, with the reason a reader needs. */
export interface NotCaseScoped {
  kind: "NOT_CASE_SCOPED";
  reason: string;
}

export interface CountedMetric {
  kind: "COUNT";
  value: number;
}

export type MetricValue = CountedMetric | NotCaseScoped;

export interface DisciplineMetric {
  /** What is being counted. Never bare — "Evidence", "Claims", "Entities", never just a number. */
  label: string;
  value: MetricValue;
  /** Shown under the row when the count needs qualifying. Null when it does not. */
  note: string | null;
}

export type DisciplineStatus = "PRESENT" | "ZERO" | "NOT_CASE_SCOPED";

export interface DisciplineSection {
  discipline: DisciplineKey;
  status: DisciplineStatus;
  metrics: DisciplineMetric[];
  /** Collector ids DECLARING this discipline, from the capability matrix. */
  declaredBy: string[];
  /** Of those, the ones that actually produced evidence in this case. */
  producedIn: string[];
  /** Declared but silent here. Not the same as "found nothing" — see `SILENT_MEANING`. */
  silent: string[];
}

export interface CaseIntelligenceBreakdown {
  caseId: string;
  sections: DisciplineSection[];
  /** Records whose producing collector declares no discipline at all. */
  untagged: { collectors: string[]; evidence: number };
  /** Records whose producing collector is absent from the supplied capability matrix. */
  unmapped: { collectors: string[]; evidence: number };
  totals: {
    evidence: number;
    entities: number;
    relationships: number;
  };
  caveats: string[];
}

export const TOTALS_OVERLAP =
  "A collector may declare more than one discipline, so one record can be counted under several. These figures overlap and do not sum to the case total.";

export const SILENT_MEANING =
  "A collector listed as declaring a discipline but producing nothing here may have run and found nothing, or may not have run at all. The stored snapshot does not distinguish these.";

export const NOT_CASE_SCOPED_MEANING =
  "Not case-scoped means the capability exists but its output is not part of this case. It is different from zero, which would mean the case was evaluated and produced no results.";

/**
 * Why GEOINT's analytical output may be absent from a case.
 *
 * Stated as a constant so the wording cannot drift between the panel and a test.
 * Image geolocation runs on `/images` and reaches a case only when an analyst
 * explicitly attaches it — counting the panel's in-memory state as case evidence
 * would be inventing a finding, so it is reported as absent instead when that
 * attach has not happened.
 *
 * It must be derived PER CASE, from that case's own records. Deriving it from
 * anything else would tell a case with nothing attached that GEOINT is scoped to
 * it.
 */
export const GEOINT_NOT_SCOPED_REASON =
  "No GEOINT record has been attached to this case. Image analysis runs on /images and reaches a case only when an analyst explicitly attaches it.";

export const BREAKDOWN_CAVEATS: string[] = [
  TOTALS_OVERLAP,
  NOT_CASE_SCOPED_MEANING,
  SILENT_MEANING,
  "Disciplines come from each collector's own declaration, never inferred from its name or output.",
  "These are counts of stored records, not an assessment of coverage. A high count is not evidence of thorough collection.",
];

// ─── Inputs ─────────────────────────────────────────────────────────────────

/** One row of the existing capability matrix — only the two fields this needs. */
export interface CollectorDisciplines {
  sourceId: string;
  disciplines: string[];
}

export interface BreakdownInput {
  caseId: string;
  evidence: readonly CollectorEvidence[];
  entities: readonly CollectorEntity[];
  relationships: readonly CollectorRelationship[];
  /**
   * From the EXISTING `capabilityReport()` server function. Empty means the
   * matrix was unavailable — every record then reports as `unmapped` rather than
   * being silently filed under a guessed discipline.
   */
  capabilityRows: readonly CollectorDisciplines[];
  /**
   * MEDIAINT claim and conflict counts, already derived by the existing claim/
   * contradiction code from this same case's evidence. Passed in rather than
   * re-derived here, so there is exactly one claim extractor in the codebase.
   */
  mediaClaims: number;
  mediaConflicts: number;
  /**
   * Whether an evidence snapshot for this case was actually read.
   *
   * Claims are derived from evidence that lives in the case's TIMELINE snapshot.
   * A case can have a graph snapshot and no timeline snapshot — evicted, never
   * written, or belonging to another case — and `mediaClaims` is then 0 because
   * nothing was examined, not because the coverage asserts nothing. Rendering
   * "Claims: 0" for that is a measured zero standing in for an unmeasured one,
   * which is the `?? 0` failure this project greps for.
   *
   * Optional and defaulting to TRUE so every pre-existing caller and test keeps
   * its behaviour: they all pass counts derived from evidence they really read.
   */
  mediaEvidenceScoped?: boolean;
  /** Infrastructure contradictions, from the same contradiction-engine derivation. */
  infrastructureContradictions: number;
  /**
   * Whether GEOINT analytical output is case-scoped. A parameter rather than a
   * hardcoded `false` so a future case with attached GEOINT records needs a
   * value, not an edit.
   */
  geointCaseScoped?: boolean;
  geointHypotheses?: number;
}

// ─── Counting ───────────────────────────────────────────────────────────────

const count = (value: number): CountedMetric => ({ kind: "COUNT", value });
const notScoped = (reason: string): NotCaseScoped => ({ kind: "NOT_CASE_SCOPED", reason });

/** collectorId → declared disciplines. Absent id means the matrix does not know it. */
function disciplineIndex(rows: readonly CollectorDisciplines[]): Map<string, string[]> {
  return new Map(rows.map((r) => [r.sourceId, r.disciplines ?? []]));
}

/**
 * Evidence grouped by producing collector.
 *
 * Uses `CollectorEvidence.collector` — the only field identifying the producer.
 * Evidence carries no discipline of its own, which is why the capability matrix
 * is required rather than optional.
 */
export function evidenceByCollector(
  evidence: readonly CollectorEvidence[],
): Map<string, CollectorEvidence[]> {
  const out = new Map<string, CollectorEvidence[]>();
  for (const e of evidence) {
    if (!e.collector) continue;
    const list = out.get(e.collector);
    if (list) list.push(e);
    else out.set(e.collector, [e]);
  }
  return out;
}

/**
 * Entities grouped by every collector that contributed them.
 *
 * Uses `contributingSourcesOf` rather than `entity.source` directly. Entity
 * resolution stamps a merged entity's `source` as `"entity-resolution"`, which is
 * honest (no single collector asserted the merged record) but would make every
 * merged entity UNMAPPED here: a discipline count silently losing entities to a
 * resolution step. The contributors live in `metadata.mergedFrom` and are read
 * back, so a merged entity is attributed to each collector that contributed it.
 *
 * One entity can therefore appear under several collectors. That is the same
 * overlap rule `TOTALS_OVERLAP` already states for evidence.
 */
export function entitiesByCollectorId(
  entities: readonly CollectorEntity[],
): Map<string, CollectorEntity[]> {
  const out = new Map<string, CollectorEntity[]>();
  for (const e of entities) {
    for (const source of contributingSourcesOf(e)) {
      const list = out.get(source);
      if (list) list.push(e);
      else out.set(source, [e]);
    }
  }
  return out;
}

/** Relationships grouped by the collector named in `source`. */
export function relationshipsByCollectorId(
  relationships: readonly CollectorRelationship[],
): Map<string, CollectorRelationship[]> {
  const out = new Map<string, CollectorRelationship[]>();
  for (const r of relationships) {
    if (!r.source) continue;
    const list = out.get(r.source);
    if (list) list.push(r);
    else out.set(r.source, [r]);
  }
  return out;
}

/**
 * Builds the breakdown.
 *
 * Pure and deterministic: no storage read, no network, no clock. Every list it
 * returns is sorted, so two runs over the same case produce byte-identical
 * output and a rendered panel can be diffed.
 */
export function buildCaseIntelligenceBreakdown(
  input: BreakdownInput,
): CaseIntelligenceBreakdown {
  const index = disciplineIndex(input.capabilityRows);
  const evByCollector = evidenceByCollector(input.evidence);
  const entByCollector = entitiesByCollectorId(input.entities);
  const relByCollector = relationshipsByCollectorId(input.relationships);

  // Collectors the matrix knows but that declare nothing, and collectors the
  // matrix has never heard of. Two different problems, reported separately.
  const untaggedCollectors: string[] = [];
  const unmappedCollectors: string[] = [];
  let untaggedEvidence = 0;
  let unmappedEvidence = 0;

  for (const [collectorId, records] of evByCollector) {
    if (!index.has(collectorId)) {
      unmappedCollectors.push(collectorId);
      unmappedEvidence += records.length;
      continue;
    }
    if ((index.get(collectorId) ?? []).length === 0) {
      untaggedCollectors.push(collectorId);
      untaggedEvidence += records.length;
    }
  }

  const sections = DISCIPLINES.map((discipline) =>
    buildSection(discipline, {
      index,
      evByCollector,
      entByCollector,
      relByCollector,
      input,
    }),
  );

  return {
    caseId: input.caseId,
    sections,
    untagged: { collectors: untaggedCollectors.sort(), evidence: untaggedEvidence },
    unmapped: { collectors: unmappedCollectors.sort(), evidence: unmappedEvidence },
    totals: {
      evidence: input.evidence.length,
      entities: input.entities.length,
      relationships: input.relationships.length,
    },
    caveats: BREAKDOWN_CAVEATS,
  };
}

interface SectionContext {
  index: Map<string, string[]>;
  evByCollector: Map<string, CollectorEvidence[]>;
  entByCollector: Map<string, CollectorEntity[]>;
  relByCollector: Map<string, CollectorRelationship[]>;
  input: BreakdownInput;
}

function buildSection(discipline: DisciplineKey, ctx: SectionContext): DisciplineSection {
  const declaredBy = [...ctx.index.entries()]
    .filter(([, ds]) => ds.includes(discipline))
    .map(([id]) => id)
    .sort();

  const producedIn = declaredBy.filter((id) => (ctx.evByCollector.get(id)?.length ?? 0) > 0);
  const silent = declaredBy.filter((id) => !producedIn.includes(id));

  const evidenceCount = producedIn.reduce(
    (n, id) => n + (ctx.evByCollector.get(id)?.length ?? 0),
    0,
  );
  /**
   * DISTINCT entities, not a sum over collectors.
   *
   * Since resolution, one merged entity is attributed to EVERY collector that
   * contributed it (`contributingSourcesOf`). Summing the per-collector lists
   * would therefore count a merged entity once per contributor: a case holding
   * two TECHINT entities would report "Entities: 4", because `dns`+`crtsh` and
   * `dns`+`shodan-internetdb` each contributed one.
   *
   * Cross-DISCIPLINE overlap is real and documented (`TOTALS_OVERLAP`); overlap
   * WITHIN one discipline is just double-counting, so this de-duplicates by
   * entity id.
   */
  const entityCount = new Set(
    declaredBy.flatMap((id) => (ctx.entByCollector.get(id) ?? []).map((e) => e.id)),
  ).size;
  const relationshipCount = declaredBy.reduce(
    (n, id) => n + (ctx.relByCollector.get(id)?.length ?? 0),
    0,
  );

  const metrics: DisciplineMetric[] = [
    { label: "Evidence", value: count(evidenceCount), note: null },
  ];

  // ── Per-discipline metrics, only where the case genuinely holds the object ──
  switch (discipline) {
    case "TECHINT":
      metrics.push(
        { label: "Entities", value: count(entityCount), note: null },
        { label: "Relationships", value: count(relationshipCount), note: null },
        {
          label: "Contradictions",
          value: count(ctx.input.infrastructureContradictions),
          note:
            ctx.input.infrastructureContradictions > 0
              ? "Disjoint claims between collectors. Flagged for review — not adjudicated."
              : null,
        },
      );
      break;

    case "MEDIAINT": {
      // An unread snapshot is NOT_CASE_SCOPED, never a zero.
      const mediaScoped = ctx.input.mediaEvidenceScoped ?? true;
      metrics.push(
        {
          label: "Claims",
          value: mediaScoped
            ? count(ctx.input.mediaClaims)
            : notScoped(MEDIAINT_NOT_CASE_SCOPED),
          note: mediaScoped
            ? "Extracted deterministically from this case's article evidence. Every claim keeps its own class (REPORTED / OFFICIAL_STATEMENT) — none becomes an observed fact."
            : null,
        },
        {
          label: "Conflicts",
          value: mediaScoped
            ? count(ctx.input.mediaConflicts)
            : notScoped(MEDIAINT_NOT_CASE_SCOPED),
          note:
            mediaScoped && ctx.input.mediaConflicts > 0
              ? "Assertion/denial pairs across different publishers. Flagged for review — the system has not established which claim is true."
              : null,
        },
      );
      break;
    }

    case "GEOINT":
      metrics.push({
        label: "Hypotheses",
        value: ctx.input.geointCaseScoped
          ? count(ctx.input.geointHypotheses ?? 0)
          : notScoped(GEOINT_NOT_SCOPED_REASON),
        note: null,
      });
      // The GEOINT evidence figure needs qualifying, and the qualifier depends
      // on WHICH producers actually contributed. Computed from the matrix and
      // from the records actually present, so it cannot go stale.
      if (evidenceCount > 0) {
        const contributing = [...ctx.evByCollector.keys()]
          .filter((id) => (ctx.index.get(id) ?? []).includes("GEOINT"))
          .sort();
        const newsOnly = contributing.length === 1 && contributing[0] === "news";
        metrics[0].note = newsOnly
          ? "From the news collector only, whose geography is the publishing outlet's country — not an event location."
          : `From collectors declaring GEOINT (${contributing.join(", ")}). The news collector's geography is the publishing outlet's country, not an event location; attached image records carry their own precision and claim class.`;
      }
      break;

    case "SOCMINT":
      // No SOCMINT claim extractor exists, so no Claims row is offered. An
      // empty row labelled "Claims: 0" would imply one ran.
      metrics.push({
        label: "Entities",
        value: count(entityCount),
        note: null,
      });
      break;
  }

  // ── Status ──────────────────────────────────────────────────────────────
  //
  // NOT_CASE_SCOPED wins only when the discipline has NO case-scoped metric at
  // all — otherwise a discipline with real evidence would be hidden behind one
  // unscoped sub-metric.
  const hasCount = metrics.some((m) => m.value.kind === "COUNT" && m.value.value > 0);
  const allUnscoped = metrics.every((m) => m.value.kind === "NOT_CASE_SCOPED");
  const status: DisciplineStatus = allUnscoped
    ? "NOT_CASE_SCOPED"
    : hasCount
      ? "PRESENT"
      : declaredBy.length === 0
        ? "NOT_CASE_SCOPED"
        : "ZERO";

  return { discipline, status, metrics, declaredBy, producedIn, silent };
}

/** One-line summary for a panel header. Never a percentage — the counts overlap. */
export function breakdownHeadline(b: CaseIntelligenceBreakdown): string {
  const present = b.sections.filter((s) => s.status === "PRESENT").map((s) => s.discipline);
  if (present.length === 0) {
    return `No discipline in this case holds any stored record. ${b.totals.evidence} evidence records total.`;
  }
  return `${present.join(", ")} present · ${b.totals.evidence} evidence, ${b.totals.entities} entities, ${b.totals.relationships} relationships in this case.`;
}
