/**
 * Maltego export — OSINT-INTEGRATION-PLAN.md §31 P3 "Maltego export."
 *
 * Converts a Sentinel investigation's entities/relationships into a CSV an
 * analyst can bring into Maltego for further link analysis — this system
 * does not build a graph UI as capable as Maltego's, and doesn't try to;
 * this is a hand-off, the same relationship this project already has with
 * `/graph` (a real but simple layout) versus a dedicated tool.
 *
 * **Format is an edge list, one row per relationship**, matching how
 * Maltego's own "Import Graph from Table" CSV wizard actually builds a
 * graph: two entity columns per row (source/target), linked to each other
 * on import. An entity with no relationships at all still gets exactly one
 * row, with the target columns empty — Maltego's wizard accepts a row with
 * only one entity column filled as a standalone node, so nothing is
 * silently dropped just for being unconnected.
 *
 * **The `mtType` column values (`maltego.Domain`, `maltego.EmailAddress`,
 * …) are a best-effort mapping from Sentinel's 13 `EntityType` values to
 * Maltego's stock entity palette, built from general knowledge of that
 * palette — not verified against a live Maltego installation**, the same
 * honest caveat this project already carries for the theHarvester/
 * SpiderFoot adapters' response parsers (no live instance to check the
 * exact strings against). This is why every row ALSO carries the original
 * Sentinel `sourceType`/`targetType` value in its own column: if a guessed
 * `mtType` is wrong or unrecognized, Maltego's import wizard lets the
 * analyst remap a column's type interactively at import time, and the
 * real Sentinel type is right there to remap from — nothing is lost to a
 * wrong guess.
 */

import type { CollectorEntity, CollectorRelationship, EntityType } from "./collectors/result";

/**
 * Best-effort Sentinel → Maltego stock entity type mapping. See file header
 * for the "not verified against a live instance" caveat. Several of these
 * (`article`, `video`, `social_account`) have no obvious stock Maltego
 * equivalent and fall back to a generic type — always with the real
 * Sentinel type preserved in its own column, never hidden.
 */
export const MALTEGO_TYPE: Record<EntityType, string> = {
  person: "maltego.Person",
  email: "maltego.EmailAddress",
  phone: "maltego.PhoneNumber",
  username: "maltego.Alias",
  domain: "maltego.Domain",
  ip: "maltego.IPv4Address",
  url: "maltego.URL",
  location: "maltego.Location",
  article: "maltego.Document",
  image: "maltego.Image",
  video: "maltego.Document",
  organization: "maltego.Organization",
  social_account: "maltego.Alias",
};

export const MALTEGO_CSV_HEADERS = [
  "Source Maltego Type",
  "Source Sentinel Type",
  "Source Value",
  "Source Display Name",
  "Source Collector",
  "Relationship",
  "Relationship Confidence",
  "Target Maltego Type",
  "Target Sentinel Type",
  "Target Value",
  "Target Display Name",
  "Target Collector",
] as const;

/** RFC 4180: quote a field if it contains a comma, quote, or newline; double any embedded quotes. */
export function csvEscape(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function csvRow(fields: string[]): string {
  return fields.map(csvEscape).join(",");
}

function entityColumns(entity: CollectorEntity): string[] {
  return [MALTEGO_TYPE[entity.type], entity.type, entity.value, entity.displayName, entity.source];
}

const EMPTY_ENTITY_COLUMNS = ["", "", "", "", ""];

/**
 * Builds the CSV. Entities are referenced only by id — a relationship whose
 * `sourceEntity`/`targetEntity` isn't in `entities` is skipped rather than
 * emitted with a bare id and no real type/value/collector to show, matching
 * `graph-layout.ts`'s same "referenced but absent entity" handling.
 */
export function toMaltegoCsv(
  entities: CollectorEntity[],
  relationships: CollectorRelationship[],
): string {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const linkedIds = new Set<string>();
  const rows: string[] = [csvRow([...MALTEGO_CSV_HEADERS])];

  for (const rel of relationships) {
    const source = byId.get(rel.sourceEntity);
    const target = byId.get(rel.targetEntity);
    if (!source || !target) continue;
    linkedIds.add(source.id);
    linkedIds.add(target.id);
    const confidence =
      rel.confidence.value !== null ? `${Math.round(rel.confidence.value * 100)}%` : "not scored";
    rows.push(
      csvRow([
        ...entityColumns(source),
        rel.relationshipType,
        confidence,
        ...entityColumns(target),
      ]),
    );
  }

  for (const entity of entities) {
    if (linkedIds.has(entity.id)) continue;
    rows.push(csvRow([...entityColumns(entity), "", "", ...EMPTY_ENTITY_COLUMNS]));
  }

  return rows.join("\r\n");
}
