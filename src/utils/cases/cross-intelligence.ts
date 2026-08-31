import type {
  ClaimClass,
  CollectorEntity,
  CollectorEvidence,
  CollectorRelationship,
  ConfidenceScore,
  RelationshipType,
} from "../collectors/result";
import { UNSCORED } from "../collectors/result";
import { contributingSourcesOf } from "./case-entities";

/**
 * Cross-intelligence correlation (2026-08-30, ported from the teammate's fork).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * IT READS RELATIONSHIPS. IT NEVER INVENTS ONE.
 *
 * This is the whole safety property, and it is structural rather than a rule
 * somebody has to remember:
 *
 *   Every correlation is derived from a relationship a collector ALREADY
 *   asserted, or from one entity's own contributor list. Nothing here compares
 *   values, matches strings, or joins two records because they look related.
 *
 * So "John Smith" + "johnsmith" + "john.smith@example.com" cannot become one
 * person, and two IPs in one ASN cannot become one organisation — not because a
 * check forbids it, but because there is no code path that could construct such
 * a link. A test greps this file to keep it that way.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * CORRELATION IS NOT IDENTITY.
 *
 * A correlation says "these observations share a supported relationship". It
 * never says "this person owns this". The relationship vocabulary already
 * encodes that distinction with real care — `CANDIDATE_ACCOUNT` is documented as
 * "a handle exists on a platform — nothing more", `CANDIDATE_IDENTITY` as "a
 * person and an identifier were seen together — NOT that the identifier is
 * theirs" — and this layer INHERITS those words rather than flattening them.
 * `IDENTITY_CANDIDATE_CORRELATION` is named for the danger it carries.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * CORRELATED IS THE RIGHT CLAIM CLASS, BY THE VOCABULARY'S OWN DEFINITION.
 *
 * `CLAIM_CLASS_DETAIL.CORRELATED` reads "Produced by relating observations from
 * more than one independent source" — which is exactly what this produces. So
 * nothing new is invented: a correlation is CORRELATED, and a correlation
 * touching a hypothesis edge is HYPOTHESIS, always.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHAT "EVIDENCE REFERENCES" CAN HONESTLY MEAN HERE.
 *
 * `CollectorRelationship` carries `source` (the asserting collector) and NO
 * evidence id — the contract has no such field. So a relationship cannot be
 * traced to the specific records that produced it, only to the evidence that
 * collector contributed to this case. That is what `evidenceRefs` holds, and
 * `EVIDENCE_REF_MEANING` says so wherever it renders. Claiming a tighter link
 * would be inventing one.
 */

// ─── Vocabulary ─────────────────────────────────────────────────────────────

/**
 * Deliberately small. Each type exists because the stored data supports it.
 *
 * `TEMPORAL_CORRELATION` was considered and REJECTED: two events falling in the
 * same period is co-occurrence, not a supported relationship, and emitting it
 * would manufacture significance the evidence does not carry. See
 * `NOT_IMPLEMENTED` below.
 */
export const CORRELATION_TYPES = [
  /** One entity that collectors from different disciplines both reported. */
  "ENTITY_CORRELATION",
  /** An infrastructure edge whose two sides come from different disciplines. */
  "INFRASTRUCTURE_CORRELATION",
  /** An entity and a media item the collector observed it mentioned in. */
  "MEDIA_ENTITY_CORRELATION",
  /** A location edge crossing into another discipline. Carries the hypothesis distinction. */
  "GEO_CORRELATION",
  /** A handle/identifier edge. NAMED for the danger: it is a candidate, never ownership. */
  "IDENTITY_CANDIDATE_CORRELATION",
  /** Two disciplines' evidence observing the same web resource. */
  "SOURCE_CORRELATION",
] as const;
export type CorrelationType = (typeof CORRELATION_TYPES)[number];

export const DISCIPLINES = ["SOCMINT", "TECHINT", "GEOINT", "MEDIAINT"] as const;
export type Discipline = (typeof DISCIPLINES)[number];

/** Correlations this layer deliberately does NOT produce, and why. */
export const NOT_IMPLEMENTED: string[] = [
  "TEMPORAL_CORRELATION — two observations falling in the same period is co-occurrence, not a supported relationship. Emitting it would manufacture significance the evidence does not carry.",
  "Value-similarity correlation — no correlation is ever produced by comparing two values. A name, a handle and an address that resemble each other stay separate records.",
  "Shared-network correlation — two addresses in one ASN are not correlated here. No collector asserts that edge, so this layer cannot see it.",
];

export const EVIDENCE_REF_MEANING =
  "Evidence references list what the ASSERTING COLLECTOR contributed to this case. `CollectorRelationship` carries no evidence id, so a relationship cannot be traced to the specific records behind it — only to that collector's records. A tighter link would be invented.";

/**
 * Printed above any correlation list, in a report or a panel.
 *
 * A report reader skims headings. "Cross-intelligence correlations" under a
 * findings-shaped layout would read as findings, so the distinction is stated
 * before the first row rather than left to a footnote.
 */
export const CORRELATION_NOT_A_FINDING =
  "A correlation is not a finding and not a confirmed fact. It records that two observations share a relationship a collector already asserted, across two or more intelligence disciplines. It establishes no ownership, no identity and no physical location.";

/** Wording when none was derived. Never "no relationships exist". */
export const NO_CORRELATIONS_MESSAGE =
  "No cross-intelligence correlations were derived from this case's data. That is not evidence that no relationship exists — only that no collector asserted one across disciplines here.";

export const CORRELATION_CAVEATS: string[] = [
  "A correlation says two observations share a supported relationship. It never says one entity owns, controls or is another.",
  "Every correlation is read from a relationship a collector already asserted, or from one entity's own contributor list. None is produced by comparing values.",
  "A correlation involving a location hypothesis stays a HYPOTHESIS. Visual geolocation is a proposal about what a picture looks like, never a record of where something was.",
  "IP geolocation associates an address with a place. It is not a statement about where any person was.",
  "A correlation with a media item records that a collector observed the mention. It does not make what the article says true — an article's claim stays REPORTED.",
  EVIDENCE_REF_MEANING,
];

// ─── Relationship → correlation type ────────────────────────────────────────

/**
 * Which correlation type a relationship expresses.
 *
 * `null` means the edge is not cross-intelligence material — it still exists as
 * an ordinary relationship, and this layer simply has nothing to add.
 */
const TYPE_BY_RELATIONSHIP: Partial<Record<RelationshipType, CorrelationType>> = {
  RESOLVES_TO: "INFRASTRUCTURE_CORRELATION",
  HOSTED_ON: "INFRASTRUCTURE_CORRELATION",
  HAS_PORT: "INFRASTRUCTURE_CORRELATION",
  OWNS_DOMAIN: "INFRASTRUCTURE_CORRELATION",
  ARCHIVED_AS: "INFRASTRUCTURE_CORRELATION",

  MENTIONED_IN: "MEDIA_ENTITY_CORRELATION",
  APPEARS_AT: "MEDIA_ENTITY_CORRELATION",
  MATCHED_TO: "MEDIA_ENTITY_CORRELATION",

  LOCATED_IN: "GEO_CORRELATION",
  HAS_METADATA_LOCATION: "GEO_CORRELATION",
  HAS_LOCATION_HYPOTHESIS: "GEO_CORRELATION",

  // Every identifier edge lands here, INCLUDING the ones whose names sound
  // definite. `HAS_EMAIL` is domain→email and deterministic, but a correlation
  // built on it still describes a relationship between records, not a person.
  HAS_EMAIL: "IDENTITY_CANDIDATE_CORRELATION",
  USES_USERNAME: "IDENTITY_CANDIDATE_CORRELATION",
  CANDIDATE_ACCOUNT: "IDENTITY_CANDIDATE_CORRELATION",
  CANDIDATE_IDENTITY: "IDENTITY_CANDIDATE_CORRELATION",
  WORKS_AT: "IDENTITY_CANDIDATE_CORRELATION",
};

/**
 * Relationship types that are ALWAYS a hypothesis, whatever confidence rides on
 * them. Mirrors `confidenceBandOf`'s own override.
 */
const HYPOTHESIS_RELATIONSHIPS: ReadonlySet<RelationshipType> = new Set([
  "HAS_LOCATION_HYPOTHESIS",
  "MATCHED_TO",
]);

// ─── Output contract ────────────────────────────────────────────────────────

export interface CorrelationEntityRef {
  id: string;
  type: string;
  value: string;
  /** Collectors that contributed this entity — from `contributingSourcesOf`. */
  contributors: string[];
  disciplines: Discipline[];
}

export interface CrossIntelligenceCorrelation {
  /** Deterministic and content-derived, so the same case always yields the same id. */
  id: string;
  type: CorrelationType;
  /** ALWAYS at least two. A single-discipline link is an ordinary relationship, not this. */
  disciplines: Discipline[];
  entities: CorrelationEntityRef[];
  /** The relationship this was read from. Absent for ENTITY_CORRELATION and SOURCE_CORRELATION. */
  relationship: {
    type: RelationshipType;
    from: string;
    to: string;
    assertedBy: string;
  } | null;
  /** See `EVIDENCE_REF_MEANING` — the asserting collectors' records, not a direct link. */
  evidenceRefs: string[];
  /** Source URLs reachable from those records, for the analyst to check. */
  sourceUrls: string[];
  /**
   * The UNDERLYING record's confidence, carried verbatim. Never recomputed, never
   * combined, never raised because more disciplines are involved.
   */
  confidence: ConfidenceScore;
  /** CORRELATED, or HYPOTHESIS when a hypothesis edge is involved. Never OBSERVED. */
  claimClass: ClaimClass;
  /** Plain wording an analyst reads. Hypothesis wording for a hypothesis. */
  explanation: string;
  limitations: string[];
}

export interface CrossIntelligenceReport {
  caseId: string;
  correlations: CrossIntelligenceCorrelation[];
  /** Relationships examined but NOT cross-discipline — reported so silence is readable. */
  singleDisciplineRelationships: number;
  /** Relationships whose type this layer has no correlation meaning for. */
  unclassifiedRelationships: number;
  caveats: string[];
  notImplemented: string[];
}

// ─── Inputs ─────────────────────────────────────────────────────────────────

/** One row of the existing capability matrix. */
export interface CollectorDisciplines {
  sourceId: string;
  disciplines: string[];
}

export interface CrossIntelligenceInput {
  caseId: string;
  /** RESOLVED entities and relationships. They must travel together. */
  entities: readonly CollectorEntity[];
  relationships: readonly CollectorRelationship[];
  evidence: readonly CollectorEvidence[];
  /** From the EXISTING `capabilityReport()`. Empty means no discipline can be established. */
  capabilityRows: readonly CollectorDisciplines[];
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function disciplineIndex(rows: readonly CollectorDisciplines[]): Map<string, Discipline[]> {
  const out = new Map<string, Discipline[]>();
  for (const r of rows) {
    out.set(
      r.sourceId,
      (r.disciplines ?? []).filter((d): d is Discipline =>
        (DISCIPLINES as readonly string[]).includes(d),
      ),
    );
  }
  return out;
}

const sortedUnique = (xs: string[]): string[] => [...new Set(xs)].sort();

/** Disciplines a set of collectors covers. Unknown collectors contribute none. */
function disciplinesOf(
  collectors: readonly string[],
  index: Map<string, Discipline[]>,
): Discipline[] {
  const out = new Set<Discipline>();
  for (const c of collectors) for (const d of index.get(c) ?? []) out.add(d);
  return [...out].sort();
}

/** Evidence ids a collector contributed to this case. Never minted. */
function evidenceForCollectors(
  collectors: readonly string[],
  evidence: readonly CollectorEvidence[],
): { refs: string[]; urls: string[] } {
  const set = new Set(collectors);
  const refs: string[] = [];
  const urls: string[] = [];
  for (const e of evidence) {
    if (!set.has(e.collector)) continue;
    if (e.evidenceId) refs.push(e.evidenceId);
    if (e.sourceUrl) urls.push(e.sourceUrl);
  }
  return { refs: sortedUnique(refs), urls: sortedUnique(urls) };
}

/** A stable id from the correlation's own content — no counter, no clock, no random. */
function correlationId(parts: readonly string[]): string {
  const key = parts.join("|");
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  return `CORR-${(hash >>> 0).toString(36).toUpperCase().padStart(7, "0")}`;
}

// ─── Build ──────────────────────────────────────────────────────────────────

/**
 * Derives a case's cross-intelligence correlations.
 *
 * Pure: no storage, no network, no clock, no model. The caller supplies data it
 * already read from this case's own scope-validated snapshots, which is what
 * makes cross-case leakage impossible — this function cannot reach another case.
 */
export function buildCrossIntelligence(
  input: CrossIntelligenceInput,
): CrossIntelligenceReport {
  const index = disciplineIndex(input.capabilityRows);
  const byId = new Map(input.entities.map((e) => [e.id, e]));
  const correlations: CrossIntelligenceCorrelation[] = [];
  let singleDiscipline = 0;
  let unclassified = 0;

  const entityRef = (e: CollectorEntity): CorrelationEntityRef => {
    const contributors = contributingSourcesOf(e);
    return {
      id: e.id,
      type: e.type,
      value: e.value,
      contributors,
      disciplines: disciplinesOf(contributors, index),
    };
  };

  // ── 1. ENTITY_CORRELATION — one entity, contributors across disciplines ──
  //
  // This is the only correlation not read from an edge, and it is still not an
  // inference: `contributingSourcesOf` reports who actually reported the entity.
  for (const e of input.entities) {
    const ref = entityRef(e);
    if (ref.disciplines.length < 2) continue;
    const { refs, urls } = evidenceForCollectors(ref.contributors, input.evidence);
    correlations.push({
      id: correlationId(["ENTITY", e.id, ...ref.disciplines]),
      type: "ENTITY_CORRELATION",
      disciplines: ref.disciplines,
      entities: [ref],
      relationship: null,
      evidenceRefs: refs,
      sourceUrls: urls,
      // The entity's OWN score, carried verbatim. Bounded already at merge time;
      // nothing here raises it because two disciplines are involved.
      confidence: e.confidence ?? UNSCORED,
      claimClass: "CORRELATED",
      explanation:
        `${ref.disciplines.join(" and ")} collectors (${ref.contributors.join(", ")}) each reported ` +
        `the ${e.type} "${e.value}". They describe the same value; this is corroboration of the value, ` +
        `not a statement about who controls it.`,
      limitations: [
        "Corroboration that a value was reported by several collectors. It says nothing about ownership or control.",
        EVIDENCE_REF_MEANING,
      ],
    });
  }

  // ── 2-5. Relationship-derived correlations ──────────────────────────────
  for (const rel of input.relationships) {
    const type = TYPE_BY_RELATIONSHIP[rel.relationshipType];
    if (!type) {
      unclassified += 1;
      continue;
    }

    const from = byId.get(rel.sourceEntity);
    const to = byId.get(rel.targetEntity);
    const fromRef = from ? entityRef(from) : null;
    const toRef = to ? entityRef(to) : null;

    // Disciplines involved: the asserting collector, plus both endpoints'
    // contributors. An edge is cross-intelligence when the OBSERVATIONS behind
    // it span disciplines — not merely because the two ends look different.
    const contributors = sortedUnique([
      rel.source,
      ...(fromRef?.contributors ?? []),
      ...(toRef?.contributors ?? []),
    ]);
    const disciplines = disciplinesOf(contributors, index);

    if (disciplines.length < 2) {
      singleDiscipline += 1;
      continue;
    }

    const { refs, urls } = evidenceForCollectors(contributors, input.evidence);
    const isHypothesis = HYPOTHESIS_RELATIONSHIPS.has(rel.relationshipType);
    const fromLabel = fromRef?.value ?? rel.sourceEntity;
    const toLabel = toRef?.value ?? rel.targetEntity;

    correlations.push({
      id: correlationId([type, rel.sourceEntity, rel.relationshipType, rel.targetEntity, rel.source]),
      type,
      disciplines,
      entities: [fromRef, toRef].filter((r): r is CorrelationEntityRef => !!r),
      relationship: {
        type: rel.relationshipType,
        from: fromLabel,
        to: toLabel,
        assertedBy: rel.source,
      },
      evidenceRefs: refs,
      sourceUrls: urls,
      // The relationship's OWN confidence, verbatim.
      confidence: rel.confidence ?? UNSCORED,
      claimClass: isHypothesis ? "HYPOTHESIS" : "CORRELATED",
      explanation: explanationFor(rel, type, fromLabel, toLabel, disciplines, isHypothesis),
      limitations: limitationsFor(type, rel.relationshipType, isHypothesis),
    });
  }

  // ── 6. SOURCE_CORRELATION — two disciplines observing one web resource ──
  correlations.push(...sourceCorrelations(input, index));

  // Deterministic ordering, and duplicate ids collapsed: two identical edges
  // from one collector must not appear twice.
  const seen = new Set<string>();
  const deduped = correlations
    .filter((c) => (seen.has(c.id) ? false : (seen.add(c.id), true)))
    .sort((a, b) => a.type.localeCompare(b.type) || a.id.localeCompare(b.id));

  return {
    caseId: input.caseId,
    correlations: deduped,
    singleDisciplineRelationships: singleDiscipline,
    unclassifiedRelationships: unclassified,
    caveats: CORRELATION_CAVEATS,
    notImplemented: NOT_IMPLEMENTED,
  };
}

/**
 * Two collectors from different disciplines that observed the SAME URL.
 *
 * Supported by the data: `CollectorEvidence.sourceUrl` is what each collector
 * actually fetched. Two disciplines landing on one resource is a real, checkable
 * relationship between the records — and nothing more than that.
 */
function sourceCorrelations(
  input: CrossIntelligenceInput,
  index: Map<string, Discipline[]>,
): CrossIntelligenceCorrelation[] {
  const byUrl = new Map<string, CollectorEvidence[]>();
  for (const e of input.evidence) {
    if (!e.sourceUrl) continue;
    const list = byUrl.get(e.sourceUrl);
    if (list) list.push(e);
    else byUrl.set(e.sourceUrl, [e]);
  }

  const out: CrossIntelligenceCorrelation[] = [];
  for (const [url, records] of [...byUrl.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const collectors = sortedUnique(records.map((r) => r.collector));
    if (collectors.length < 2) continue;
    const disciplines = disciplinesOf(collectors, index);
    if (disciplines.length < 2) continue;

    out.push({
      id: correlationId(["SOURCE", url, ...collectors]),
      type: "SOURCE_CORRELATION",
      disciplines,
      entities: [],
      relationship: null,
      evidenceRefs: sortedUnique(records.map((r) => r.evidenceId).filter((v): v is string => !!v)),
      sourceUrls: [url],
      // No defensible way to score "two collectors fetched one URL". Null, per
      // the rule that an uncomputable confidence stays unmeasured.
      confidence: UNSCORED,
      claimClass: "CORRELATED",
      explanation:
        `${disciplines.join(" and ")} collectors (${collectors.join(", ")}) each observed the same ` +
        `resource at ${url}. They looked at one page; that is all this establishes.`,
      limitations: [
        "Two collectors observing one URL. It does not mean they extracted the same thing from it, nor that the page's content is true.",
        "No confidence is computed — there is no defensible way to score the fact that two collectors fetched one address.",
      ],
    });
  }
  return out;
}

function explanationFor(
  rel: CollectorRelationship,
  type: CorrelationType,
  from: string,
  to: string,
  disciplines: Discipline[],
  isHypothesis: boolean,
): string {
  const who = `${disciplines.join(" and ")} evidence`;
  const asserted = `asserted by ${rel.source}`;

  if (isHypothesis) {
    // Hypothesis wording, always. Never "is at", never "was taken at".
    return (
      `Visual/derived hypothesis only: ${from} is PROPOSED to relate to ${to} ` +
      `(${rel.relationshipType}, ${asserted}), linking ${who}. This is a proposal for analyst ` +
      `review, not a record of where or what anything was.`
    );
  }

  switch (type) {
    case "IDENTITY_CANDIDATE_CORRELATION":
      return (
        `${from} and ${to} were observed together via ${rel.relationshipType} (${asserted}), ` +
        `linking ${who}. This is a CANDIDATE association between records — it does not establish ` +
        `that any person owns, controls or is either of them.`
      );
    case "MEDIA_ENTITY_CORRELATION":
      return (
        `${rel.source} observed ${from} referenced in ${to} (${rel.relationshipType}), linking ` +
        `${who}. The mention was observed; what the item says about it remains that item's own ` +
        `reported claim.`
      );
    case "GEO_CORRELATION":
      return (
        `${from} carries a recorded location association with ${to} (${rel.relationshipType}, ` +
        `${asserted}), linking ${who}. A recorded location associates the RECORD with a place; ` +
        `it is not a statement about where any person was.`
      );
    case "INFRASTRUCTURE_CORRELATION":
    default:
      return (
        `${from} ${rel.relationshipType.toLowerCase().replace(/_/g, " ")} ${to} (${asserted}), ` +
        `linking ${who}.`
      );
  }
}

function limitationsFor(
  type: CorrelationType,
  rel: RelationshipType,
  isHypothesis: boolean,
): string[] {
  const base = [EVIDENCE_REF_MEANING];
  if (isHypothesis) {
    base.unshift(
      "This correlation rests on a HYPOTHESIS edge. It is a proposal for review and must never be restated as an observation.",
    );
  }
  switch (type) {
    case "IDENTITY_CANDIDATE_CORRELATION":
      base.unshift(
        rel === "CANDIDATE_ACCOUNT"
          ? "A handle exists on a platform. Two different people can hold the same handle, and a handle matching a name is not evidence that person registered it."
          : "Records observed together. Names beside addresses on public pages go stale, and role addresses belong to organisations rather than people.",
      );
      break;
    case "MEDIA_ENTITY_CORRELATION":
      base.unshift(
        "A mention was observed. It does not make the item's claim true, and two items mentioning one entity do not describe one event.",
      );
      break;
    case "GEO_CORRELATION":
      base.unshift(
        "A location association on a record. IP and metadata geolocation associate an address or a file with a place — never a person with a place.",
      );
      break;
    case "INFRASTRUCTURE_CORRELATION":
      base.unshift(
        "An infrastructure relationship at the time of collection. Shared hosting is common and does not imply shared ownership.",
      );
      break;
    default:
      break;
  }
  return base;
}

// ─── Summary ────────────────────────────────────────────────────────────────

export interface CrossIntelligenceSummary {
  total: number;
  byType: Record<string, number>;
  /** Discipline PAIRS present, e.g. "SOCMINT+TECHINT". */
  pairs: string[];
  hypotheses: number;
  unscored: number;
}

export function summariseCrossIntelligence(
  report: CrossIntelligenceReport,
): CrossIntelligenceSummary {
  const byType: Record<string, number> = {};
  const pairs = new Set<string>();
  for (const c of report.correlations) {
    byType[c.type] = (byType[c.type] ?? 0) + 1;
    for (let i = 0; i < c.disciplines.length; i += 1) {
      for (let j = i + 1; j < c.disciplines.length; j += 1) {
        pairs.add(`${c.disciplines[i]}+${c.disciplines[j]}`);
      }
    }
  }
  return {
    total: report.correlations.length,
    byType,
    pairs: [...pairs].sort(),
    hypotheses: report.correlations.filter((c) => c.claimClass === "HYPOTHESIS").length,
    unscored: report.correlations.filter((c) => c.confidence.value === null).length,
  };
}

/** Every evidence id a correlation set cites — for validating that none was invented. */
export function citedEvidenceIds(report: CrossIntelligenceReport): Set<string> {
  const out = new Set<string>();
  for (const c of report.correlations) for (const r of c.evidenceRefs) out.add(r);
  return out;
}
