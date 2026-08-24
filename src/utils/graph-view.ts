/**
 * One view model for both knowledge graphs.
 *
 * ── WHY THIS FILE EXISTS ──────────────────────────────────────────────────
 *
 * `/graph` was the collision point of two independently-built features that
 * each believed they owned the route:
 *
 *   INVESTIGATION  `graph-store.ts` + `graph-layout.ts` — entities and
 *                  relationships produced by the OSINT collector framework and
 *                  handed over from `/recon`'s "View in Graph". Vocabulary is
 *                  `collectors/result.ts`: domain, ip, email, username, …
 *
 *   CORPUS         `graph-build.ts` — entity CO-OCCURRENCE across a live
 *                  article corpus (Module 2). Vocabulary is the frozen
 *                  contract in `types/core.ts`: PERSON, ORG, LOCATION, …
 *
 * Neither imports the other, and merging their hunks was impossible because
 * they are not two versions of one thing — they are two different analyses that
 * happen to draw circles and lines. Picking one deleted a working feature.
 *
 * So they are unified where they genuinely agree — at the point where both have
 * become "positioned nodes, edges between them, and a reason each exists" — and
 * left alone everywhere they do not. `layoutRadial`, `shortestPath`,
 * `buildEntityGraph`, `layoutGraph`, `toMaltegoCsv` and both stores are
 * untouched; this is an adapter over them, not a replacement for them.
 *
 * ── WHAT IS DELIBERATELY NOT UNIFIED ──────────────────────────────────────
 *
 * The two entity vocabularies are NOT merged into one enum. `types/core.ts` is
 * a FROZEN inter-developer contract, and the collector vocabulary has no
 * member meaning EVENT or EQUIPMENT. Flattening them would either widen a
 * frozen contract or silently relabel an entity as a type it is not, and a
 * mislabelled entity in an intelligence graph is a fabricated finding. Each
 * source keeps its own vocabulary and declares its own colours; the view model
 * carries the type as an opaque id plus a human label.
 */

import type { CollectorEntity, CollectorRelationship, EntityType } from "./collectors/result";
import { layoutRadial, shortestPath as snapshotShortestPath } from "./graph-layout";
import type { GraphSnapshot } from "./graph-store";
import {
  layoutGraph,
  nodeRadius,
  shortestPath as corpusShortestPath,
  COOCCURRENCE_CAVEAT,
  type EntityGraph,
} from "./graph-build";

// ─── The model ─────────────────────────────────────────────────────────────

export type GraphSource = "investigation" | "corpus";

export interface GraphViewNode {
  id: string;
  /** Primary text on the node and in the detail panel. */
  label: string;
  /** Second line in the detail panel. The raw value, or the type. */
  sublabel: string;
  /** Opaque per-source type id. Used for colour and search, never compared across sources. */
  typeId: string;
  typeLabel: string;
  x: number;
  y: number;
  r: number;
  /** BFS distance from the root. Null when this source has no root concept. */
  ring: number | null;
  degree: number;
  /**
   * Rows for the detail panel. Every entry is something the source actually
   * reported — an adapter must not add a row it had to invent to fill the shape.
   */
  facts: { label: string; value: string }[];
}

export interface GraphViewEdge {
  a: string;
  b: string;
  /** Relationship name, or null when the source's edges are unlabelled. */
  label: string | null;
  /** Co-occurrence count, or null when edges are not weighted. */
  weight: number | null;
}

export interface GraphView {
  source: GraphSource;
  /** Nodes that survived the render cap, already positioned. */
  nodes: GraphViewNode[];
  edges: GraphViewEdge[];
  /** Total BEFORE the render cap, so the UI can say "150 of 613". */
  totalNodes: number;
  truncated: boolean;
  rootId: string | null;
  /** Entities with no path to the root. Null when the source has no root. */
  unreachedCount: number | null;
  /** Methodological limit that must be shown with the graph, or null. */
  caveat: string | null;
  /**
   * Whether a Maltego CSV can be produced from this source.
   *
   * True only for `investigation`. The corpus vocabulary has no collector-side
   * equivalent for EVENT, EQUIPMENT or OTHER, and `MALTEGO_TYPE` is keyed on
   * the collector enum — so exporting a corpus graph would mean assigning those
   * entities a Maltego type nobody measured. The button is hidden for corpus
   * graphs and the reason is stated in the UI rather than silently omitted.
   */
  maltegoExportable: boolean;
}

/**
 * Render caps.
 *
 * The investigation cap was already 150 (crt.sh alone can return thousands);
 * the corpus cap is applied earlier, inside `buildEntityGraph`, at
 * DEFAULT_MAX_NODES. Both are reported, never silent — a truncated graph that
 * looks complete tells the analyst the corpus is smaller than it is.
 */
export const MAX_RENDERED_NODES = 150;

// ─── Investigation adapter ─────────────────────────────────────────────────

/** 13 evenly-spaced hues so every collector type is genuinely distinguishable. */
export const INVESTIGATION_HUE: Record<EntityType, number> = {
  image: 0,
  phone: 27,
  article: 55,
  location: 83,
  video: 111,
  organization: 138,
  ip: 166,
  domain: 194,
  person: 221,
  url: 249,
  social_account: 277,
  email: 304,
  username: 332,
};

const INVESTIGATION_TYPE_LABEL: Record<EntityType, string> = {
  person: "Person",
  email: "Email address",
  phone: "Phone number",
  username: "Username",
  domain: "Domain",
  ip: "IP address",
  url: "URL",
  location: "Location",
  article: "Article",
  image: "Image",
  video: "Video",
  organization: "Organisation",
  social_account: "Social account",
};

export function investigationRootId(snapshot: GraphSnapshot): string | null {
  const target = snapshot.target.trim().toLowerCase();
  return snapshot.entities.find((e) => e.value.toLowerCase() === target)?.id ?? null;
}

export function viewFromInvestigation(
  snapshot: GraphSnapshot,
  opts: { width?: number; height?: number; maxNodes?: number } = {},
): GraphView {
  const width = opts.width ?? 800;
  const height = opts.height ?? 560;
  const cap = opts.maxNodes ?? MAX_RENDERED_NODES;

  const entities = snapshot.entities;
  const relationships = snapshot.relationships;
  const rootId = investigationRootId(snapshot);
  const layout = layoutRadial(entities, relationships, rootId, { width, height });

  // Closest-to-root first, so a capped render keeps the entities nearest the
  // investigated target rather than an arbitrary slice.
  const ordered = [...layout.nodes].sort((a, b) => (a.ring ?? Infinity) - (b.ring ?? Infinity));
  const kept = ordered.slice(0, cap);
  const keptIds = new Set(kept.map((n) => n.id));
  const byId = new Map(entities.map((e) => [e.id, e]));

  const degree = new Map<string, number>();
  for (const r of relationships) {
    degree.set(r.sourceEntity, (degree.get(r.sourceEntity) ?? 0) + 1);
    degree.set(r.targetEntity, (degree.get(r.targetEntity) ?? 0) + 1);
  }

  const nodes: GraphViewNode[] = kept.map((n) => {
    const e = byId.get(n.id);
    const facts: { label: string; value: string }[] = [];
    if (e) {
      facts.push({ label: "Value", value: e.value });
      facts.push({ label: "Collector", value: e.source });
      // `confidence.value` is null until something actually computes a score —
      // never a placeholder. Rendering null as "0.00" would turn "nobody
      // scored this" into "scored, and worthless", which are opposite claims.
      facts.push({
        label: "Confidence",
        value: e.confidence.value === null ? "not scored" : e.confidence.value.toFixed(2),
      });
      // The reasons are what make a bare number trustworthy, so show them when
      // a score exists rather than leaving the analyst to trust the digits.
      if (e.confidence.reasons.length > 0) {
        facts.push({ label: "Confidence basis", value: e.confidence.reasons.join("; ") });
      }
    }
    return {
      id: n.id,
      label: e?.displayName ?? n.id,
      sublabel: e?.value ?? "",
      typeId: e?.type ?? "person",
      typeLabel: e ? INVESTIGATION_TYPE_LABEL[e.type] : "Unknown",
      x: n.x,
      y: n.y,
      r: n.r,
      ring: n.ring,
      degree: degree.get(n.id) ?? 0,
      facts,
    };
  });

  const edges: GraphViewEdge[] = relationships
    .filter((r) => keptIds.has(r.sourceEntity) && keptIds.has(r.targetEntity))
    .map((r) => ({
      a: r.sourceEntity,
      b: r.targetEntity,
      label: r.relationshipType,
      weight: null,
    }));

  return {
    source: "investigation",
    nodes,
    edges,
    totalNodes: layout.nodes.length,
    truncated: layout.nodes.length > kept.length,
    rootId,
    unreachedCount: layout.unreachedCount,
    caveat: null,
    maltegoExportable: true,
  };
}

// ─── Corpus adapter ────────────────────────────────────────────────────────

/** Six well-separated hues for the frozen contract's vocabulary. */
export const CORPUS_HUE: Record<string, number> = {
  PERSON: 221,
  ORG: 138,
  LOCATION: 83,
  EVENT: 27,
  EQUIPMENT: 300,
  OTHER: 250,
};

const CORPUS_TYPE_LABEL: Record<string, string> = {
  PERSON: "Person",
  ORG: "Organisation",
  LOCATION: "Location",
  EVENT: "Event",
  EQUIPMENT: "Equipment",
  OTHER: "Other",
};

export function viewFromCorpus(
  graph: EntityGraph,
  opts: { width?: number; height?: number } = {},
): GraphView {
  const width = opts.width ?? 800;
  const height = opts.height ?? 560;

  const positioned = layoutGraph(graph, { width, height });
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));

  const nodes: GraphViewNode[] = positioned.map((p) => {
    const n = byId.get(p.id);
    const facts: { label: string; value: string }[] = [];
    if (n) {
      facts.push({ label: "Articles", value: String(n.articleIds.length) });
      facts.push({ label: "Distinct publishers", value: String(n.sources.length) });
      facts.push({ label: "Best extractor confidence", value: n.bestConfidence.toFixed(2) });
      // Credibility is genuinely optional — Module 1 may not have scored the
      // naming articles. "not scored" is the honest absence marker; a 0 here
      // would read as "scored, and worthless".
      facts.push({
        label: "Best source credibility",
        value: n.bestCredibility === null ? "not scored" : n.bestCredibility.toFixed(2),
      });
    }
    return {
      id: p.id,
      label: n?.label ?? p.id,
      sublabel: n ? CORPUS_TYPE_LABEL[n.type] ?? n.type : "",
      typeId: n?.type ?? "OTHER",
      typeLabel: n ? (CORPUS_TYPE_LABEL[n.type] ?? n.type) : "Unknown",
      x: p.x,
      y: p.y,
      r: n ? nodeRadius(n) : 10,
      // Co-occurrence has no root entity, so there are no rings. Null rather
      // than 0 — 0 would mean "at the root", which is a claim this source
      // cannot make.
      ring: null,
      degree: n?.degree ?? 0,
      facts,
    };
  });

  const edges: GraphViewEdge[] = graph.edges.map((e) => ({
    a: e.a,
    b: e.b,
    label: null,
    weight: e.weight,
  }));

  return {
    source: "corpus",
    nodes,
    edges,
    totalNodes: graph.totalNodes,
    truncated: graph.truncated,
    rootId: null,
    unreachedCount: null,
    caveat: COOCCURRENCE_CAVEAT,
    maltegoExportable: false,
  };
}

// ─── Shared operations ─────────────────────────────────────────────────────

export function hueFor(view: GraphView, typeId: string): number {
  const map = view.source === "investigation" ? INVESTIGATION_HUE : CORPUS_HUE;
  return (map as Record<string, number>)[typeId] ?? 250;
}

export function colourFor(view: GraphView, typeId: string): string {
  return `oklch(0.62 0.17 ${hueFor(view, typeId)})`;
}

/**
 * Search across the rendered nodes.
 *
 * Matches label, sublabel and type so an analyst can filter by "domain" or
 * "PERSON" as readily as by a name. Returns ids, not nodes, because the caller
 * dims rather than removes — hiding a non-match would change the shape of the
 * graph, which is itself a claim about the data.
 */
export function matchNodes(view: GraphView, query: string): Set<string> {
  const q = query.trim().toLowerCase();
  const all = new Set(view.nodes.map((n) => n.id));
  if (!q) return all;
  return new Set(
    view.nodes
      .filter(
        (n) =>
          n.label.toLowerCase().includes(q) ||
          n.sublabel.toLowerCase().includes(q) ||
          n.typeId.toLowerCase().includes(q) ||
          n.typeLabel.toLowerCase().includes(q),
      )
      .map((n) => n.id),
  );
}

/** One hop of a path. `via` is the relationship traversed, where the source names one. */
export interface GraphViewPathStep {
  id: string;
  /** Relationship that reached this node, or null for the first node / an unlabelled edge. */
  via: string | null;
}

/**
 * Shortest path between two nodes, dispatched to whichever engine owns the
 * source's data.
 *
 * The two implementations are NOT interchangeable — the investigation one walks
 * `CollectorRelationship[]` and names the relationship it traversed, the corpus
 * one walks an `EntityGraph` whose edges are co-occurrence counts with no
 * relationship name at all. Rather than flatten both to bare ids and lose the
 * investigation's edge labels, the step keeps `via` and the corpus adapter
 * fills it with null — an absent label, not an invented one.
 *
 * Returns null when no path exists, which is a real finding ("these entities
 * are not connected in what was collected") and not an error.
 */
export function pathBetween(
  view: GraphView,
  raw: { entities: CollectorEntity[]; relationships: CollectorRelationship[] } | EntityGraph,
  from: string,
  to: string,
): GraphViewPathStep[] | null {
  if (view.source === "investigation") {
    const s = raw as { entities: CollectorEntity[]; relationships: CollectorRelationship[] };
    const steps = snapshotShortestPath(s.entities, s.relationships, from, to);
    if (!steps) return null;
    return steps.map((step) => ({ id: step.entityId, via: step.viaRelationship ?? null }));
  }
  const ids = corpusShortestPath(raw as EntityGraph, from, to);
  if (!ids) return null;
  return ids.map((id) => ({ id, via: null }));
}

/** Every distinct type present, for a legend. Ordered by frequency, then name. */
export function typeLegend(view: GraphView): { typeId: string; label: string; count: number }[] {
  const counts = new Map<string, { label: string; count: number }>();
  for (const n of view.nodes) {
    const entry = counts.get(n.typeId) ?? { label: n.typeLabel, count: 0 };
    entry.count += 1;
    counts.set(n.typeId, entry);
  }
  return [...counts.entries()]
    .map(([typeId, v]) => ({ typeId, label: v.label, count: v.count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/** Empty view, so a caller never has to special-case null before rendering. */
export function emptyView(source: GraphSource): GraphView {
  return {
    source,
    nodes: [],
    edges: [],
    totalNodes: 0,
    truncated: false,
    rootId: null,
    unreachedCount: null,
    caveat: source === "corpus" ? COOCCURRENCE_CAVEAT : null,
    maltegoExportable: source === "investigation",
  };
}
