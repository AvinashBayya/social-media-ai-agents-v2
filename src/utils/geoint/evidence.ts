/**
 * GEOINT → evidence, entities and relationships (2026-08-30, ported from the
 * teammate's fork).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NO SECOND EVIDENCE MODEL. This projects GEOINT records into the EXISTING
 * `CollectorEvidence` shape from `collectors/result.ts`, the same one every
 * collector, the evidence timeline and MEDIAINT claims already speak. Nothing
 * new is defined here except the projection.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * HOW THE TIMELINE PICKS THESE UP, AND THE ONE RULE THAT MATTERS.
 *
 * `osint/timeline.ts` reads an observation time from a fixed key list
 * (`OBSERVED_AT_KEYS`) on `normalizedValue`, and validates it is a real ISO
 * instant before using it. So an `observedAt` is emitted here ONLY when one
 * genuinely exists:
 *
 *   - EXIF: only from `ExifCaptureTime.absolute`, which `imaging.ts` populates
 *     only when the file recorded a UTC offset. A bare camera wall clock is NOT
 *     an instant and is never promoted into one — that is the 5.5-hour silent
 *     shift this codebase already fixed once.
 *   - Matches / hypotheses: only when the provider or analyst supplied a time.
 *
 * Everything else lands in the timeline as `RETRIEVED` — positioned by when we
 * read it, and labelled as such.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ENTITY DEDUPLICATION. Location entities are keyed on the rounded coordinate
 * (`locationEntityId`), so an EXIF fix and a hypothesis pointing at the same
 * place produce ONE location entity joined by two DIFFERENT edges —
 * `HAS_METADATA_LOCATION` (observed) and `HAS_LOCATION_HYPOTHESIS` (guessed).
 * Merging the edges would erase the only distinction that matters.
 */

import type {
  CollectorEntity,
  CollectorEvidence,
  CollectorRelationship,
} from "../collectors/result";
import { UNSCORED } from "../collectors/result";
import type { GeoPrecision } from "../geo";
import { PRECISION_RADIUS_M } from "../geo";
import type { MetadataGeoint } from "./metadata";
import { locationEntityId, locationLabel } from "./metadata";
import type { ImageMatch } from "./image-match";
import type { LocationHypothesis } from "./geolocation-hypothesis";

const COLLECTOR = "geoint";

/**
 * Reconciling two producers that land on the SAME location entity.
 *
 * `locationEntityId` rounds to 5 dp and deliberately omits precision, so an EXIF
 * exact fix and a city-precision hypothesis that round to the same coordinate
 * collapse into one entity. A naive `if (!entities.has(locId))` guard would make
 * it first-wins: a guess arriving after a fix would inherit `precision: "exact"`
 * and `origin: "exif-metadata"`, and a guess arriving first would keep its own
 * coarse precision while a real fix was discarded.
 *
 * The evidence records are always correct and separate — it is the ENTITY that
 * would lie, and an entity is what the graph and the map render.
 *
 * Reconciled rather than merged or duplicated:
 *   - **precision takes the COARSEST of the two**, measured by the existing
 *     `PRECISION_RADIUS_M`, so a guess can never inherit a pinpoint. Widening an
 *     uncertainty is honest; narrowing it is not.
 *   - **origins are a union**, so the record says both producers reported here
 *     rather than last-wins.
 *   - confidence keeps the FIRST writer's score. Deliberate: the two numbers
 *     measure different things (a reading of a file vs a provider's guess) and
 *     there is no defensible way to combine them — the same rule already
 *     settled for entity-resolution's merge confidence.
 *
 * The two EDGES stay distinct regardless. `HAS_METADATA_LOCATION` and
 * `HAS_LOCATION_HYPOTHESIS` are the only carriers of the observed/guessed
 * distinction, because `CollectorRelationship` has no `claimClass`.
 */
function upsertLocation(
  entities: Map<string, CollectorEntity>,
  id: string,
  next: CollectorEntity,
): void {
  const prev = entities.get(id);
  if (!prev) {
    entities.set(id, next);
    return;
  }

  const prevMeta = (prev.metadata ?? {}) as Record<string, unknown>;
  const nextMeta = (next.metadata ?? {}) as Record<string, unknown>;

  const prevPrecision = prevMeta.precision as GeoPrecision | undefined;
  const nextPrecision = nextMeta.precision as GeoPrecision | undefined;
  const coarsest =
    prevPrecision && nextPrecision
      ? PRECISION_RADIUS_M[nextPrecision] > PRECISION_RADIUS_M[prevPrecision]
        ? nextPrecision
        : prevPrecision
      : (prevPrecision ?? nextPrecision);

  const origins = new Set<string>();
  for (const o of [prevMeta.origin, nextMeta.origin].flat()) {
    if (typeof o === "string" && o) origins.add(o);
  }

  entities.set(id, {
    ...prev,
    metadata: {
      ...prevMeta,
      ...(coarsest ? { precision: coarsest } : {}),
      origin: [...origins].sort(),
    },
  });
}

export interface GeoIntBundle {
  metadata: MetadataGeoint | null;
  matches: readonly ImageMatch[];
  hypotheses: readonly LocationHypothesis[];
}

export interface GeoIntGraph {
  entities: CollectorEntity[];
  relationships: CollectorRelationship[];
  evidence: CollectorEvidence[];
}

function imageEntity(imageRef: string, label: string): CollectorEntity {
  return {
    id: `geoint:image:${imageRef}`,
    type: "image",
    value: imageRef,
    displayName: label,
    source: COLLECTOR,
    confidence: UNSCORED,
    metadata: {},
  };
}

/**
 * Builds the entity/relationship/evidence set for one image.
 *
 * Pure. `retrievedAt` comes from the records themselves, which had it injected.
 */
export function geointGraph(imageRef: string, bundle: GeoIntBundle): GeoIntGraph {
  const entities = new Map<string, CollectorEntity>();
  const relationships: CollectorRelationship[] = [];
  const evidence: CollectorEvidence[] = [];

  const imgId = `geoint:image:${imageRef}`;
  entities.set(imgId, imageEntity(imageRef, bundle.metadata?.sourceFile ?? imageRef));

  // ── 1. Metadata ─────────────────────────────────────────────────────────
  const md = bundle.metadata;
  if (md) {
    for (const obs of md.observations) {
      evidence.push({
        source: `EXIF · ${md.sourceFile}`,
        sourceUrl: null,
        collector: COLLECTOR,
        evidenceId: `geoint:exif:${imageRef}:${obs.field}`,
        collectedAt: md.retrievedAt,
        rawValue: obs.rawValue,
        normalizedValue: {
          // `osint/timeline.ts` reads the evidence's SUBJECT from the first of
          // ["entity","url","value","domain","host","ip"]. Without this key an
          // EXIF record's `value` matched instead — so the timeline named
          // "Canon EOS R5" as the thing the investigation was about. The subject
          // of an EXIF observation is the IMAGE; `entity` is checked first.
          entity: imageRef,
          field: obs.field,
          value: obs.normalizedValue,
          // Only a genuine instant. Null for a wall clock without an offset.
          ...(md.observedAt ? { observedAt: md.observedAt } : {}),
        },
        confidence: md.confidence,
        claimClass: obs.claimClass,
        metadata: {
          method: "exif",
          captureWallClock: md.captureWallClock,
          captureOffset: md.captureOffset,
          // States plainly why no instant was emitted, rather than leaving a gap.
          absoluteTimeUnavailable: md.observedAt === null,
        },
      });
    }

    if (md.location) {
      const locId = locationEntityId(md.location);
      // Deduplicated by coordinate, and RECONCILED on collision — see
      // `upsertLocation`. Never first-wins: a hypothesis must not inherit an
      // EXIF fix's `exact` precision by arriving second.
      upsertLocation(entities, locId, {
        id: locId,
        type: "location",
        value: locationLabel(md.location),
        displayName: locationLabel(md.location),
        source: COLLECTOR,
        confidence: md.confidence,
        metadata: {
          lat: md.location.lat,
          lon: md.location.lon,
          precision: md.location.precision,
          altitude: md.altitude,
          origin: "exif-metadata",
        },
      });
      relationships.push({
        sourceEntity: imgId,
        // OBSERVED edge: the file said so. Distinct from the hypothesis edge below.
        relationshipType: "HAS_METADATA_LOCATION",
        targetEntity: locId,
        confidence: md.confidence,
        source: COLLECTOR,
      });
    }
  }

  // ── 2. Reverse-image matches ────────────────────────────────────────────
  for (const m of bundle.matches) {
    evidence.push({
      source: `${m.provider} · ${m.matchType}`,
      sourceUrl: m.matchedUrl,
      collector: COLLECTOR,
      evidenceId: m.matchId,
      collectedAt: m.retrievedAt,
      rawValue: { description: m.description, hammingDistance: m.hammingDistance },
      normalizedValue: {
        entity: imageRef,
        matchType: m.matchType,
        url: m.matchedUrl,
        provider: m.provider,
        ...(m.observedAt ? { observedAt: m.observedAt } : {}),
      },
      confidence: m.confidence,
      claimClass: m.claimClass,
      metadata: {
        discoveredBy: m.discoveredBy,
        screenshotRef: m.screenshotRef,
        notes: m.notes,
        hammingDistance: m.hammingDistance,
      },
    });

    if (m.matchedUrl) {
      const urlId = `geoint:url:${m.matchedUrl}`;
      if (!entities.has(urlId)) {
        entities.set(urlId, {
          id: urlId,
          type: "url",
          value: m.matchedUrl,
          displayName: m.matchedUrl,
          source: COLLECTOR,
          confidence: m.confidence,
          metadata: { matchType: m.matchType, provider: m.provider },
        });
      }
      relationships.push({
        sourceEntity: imgId,
        // "Found published here" — never "originated here".
        relationshipType: "APPEARS_AT",
        targetEntity: urlId,
        confidence: m.confidence,
        source: COLLECTOR,
      });
    } else if (m.discoveredBy === "AUTOMATED_PROVIDER" && m.hammingDistance !== null) {
      // A local pHash hit against an UPLOADED file has no URL — `/images` writes
      // `url: ""` for every upload — so the `if (m.matchedUrl)` branch above
      // skips it and a genuine, measured near-duplicate would otherwise produce
      // one evidence record and ZERO graph edges. The match would vanish from
      // the case graph entirely.
      //
      // `MATCHED_TO` exists in the frozen vocabulary for exactly this. Its own
      // detail states the limit this must keep: a perceptual match is "never an
      // assertion that they depict the same event". This is NOT a
      // value-similarity guess — a Hamming distance is a measurement, which is
      // why the edge is emitted only when one exists.
      //
      // The counterpart image entity is created so the edge has a real endpoint;
      // an edge to an id no consumer knows is silently dropped by both
      // `graph-view` and `maltego-export`.
      const counterpartId = `geoint:image:${m.matchId}`;
      if (!entities.has(counterpartId)) {
        entities.set(counterpartId, {
          id: counterpartId,
          type: "image",
          value: m.matchId,
          // Named for what it is. This browser's corpus holds no filename for
          // the counterpart, and inventing one would be a fabricated label.
          displayName: `Corpus image · Hamming ${m.hammingDistance}`,
          source: COLLECTOR,
          confidence: m.confidence,
          metadata: {
            matchType: m.matchType,
            provider: m.provider,
            hammingDistance: m.hammingDistance,
            corpus: "browser-local",
          },
        });
      }
      relationships.push({
        sourceEntity: imgId,
        relationshipType: "MATCHED_TO",
        targetEntity: counterpartId,
        confidence: m.confidence,
        source: COLLECTOR,
      });
    }
  }

  // ── 3. Location hypotheses ──────────────────────────────────────────────
  for (const h of bundle.hypotheses) {
    evidence.push({
      source: `${h.provider} · visual geolocation`,
      sourceUrl: null,
      collector: COLLECTOR,
      evidenceId: h.hypothesisId,
      collectedAt: h.retrievedAt,
      rawValue: { candidateLocation: h.candidateLocation, reasoning: h.reasoning },
      normalizedValue: {
        // The subject is the IMAGE, never the guessed place. Putting
        // `candidateLocation` in the subject position would feed a hypothesis
        // into the timeline's first-seen/last-seen and corroboration counting.
        entity: imageRef,
        candidateLocation: h.candidateLocation,
        lat: h.point?.lat ?? null,
        lon: h.point?.lon ?? null,
        ...(h.observedAt ? { observedAt: h.observedAt } : {}),
      },
      confidence: h.confidence,
      // Always HYPOTHESIS. `confidenceBandOf` forces the HYPOTHESIS band from it,
      // whatever number the provider attached.
      claimClass: h.claimClass,
      metadata: {
        classification: h.classification,
        reasoning: h.reasoning,
        providerVersion: h.providerVersion,
        discoveredBy: h.discoveredBy,
        notes: h.notes,
      },
    });

    if (h.point) {
      const locId = locationEntityId(h.point);
      upsertLocation(entities, locId, {
        id: locId,
        type: "location",
        value: locationLabel(h.point),
        displayName: h.candidateLocation,
        source: COLLECTOR,
        confidence: h.confidence,
        metadata: {
          lat: h.point.lat,
          lon: h.point.lon,
          precision: h.point.precision,
          origin: "visual-hypothesis",
        },
      });
      relationships.push({
        sourceEntity: imgId,
        // The guessed edge. NEVER merged with HAS_METADATA_LOCATION, even when
        // both point at the same deduplicated location entity.
        relationshipType: "HAS_LOCATION_HYPOTHESIS",
        targetEntity: locId,
        confidence: h.confidence,
        source: COLLECTOR,
      });
    }
  }

  return { entities: [...entities.values()], relationships, evidence };
}
