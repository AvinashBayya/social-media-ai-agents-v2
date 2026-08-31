import type { CollectorEntity, CollectorRelationship, RelationshipType } from "./collectors/result";

/**
 * Radial graph layout — OSINT-INTEGRATION-PLAN.md §31 P2 "Graph".
 *
 * The fixture this replaces on `/graph` used ten hand-placed pixel
 * coordinates for ten hardcoded nodes; that has no meaning for a real
 * investigation's entity set, which can run from a handful of nodes to
 * hundreds. This is a deterministic, dependency-free replacement: BFS rings
 * outward from one root entity (typically the investigated target), each
 * ring's nodes spaced evenly by angle. No physics simulation, no external
 * layout library — a `d3-force`-style iterative layout would look smoother
 * for a dense graph, but pulling in a new rendering dependency for a demo-
 * scale graph is more than this step needs, and a fixed BFS-ring layout is
 * trivially testable (exact positions, not a converged approximation).
 *
 * Pure and DOM-free on purpose, matching this project's established pure/
 * impure split (`imaging.ts`/`imaging-client.ts`, `credibility.ts`) — kept
 * out of `routes/graph.tsx` specifically so `bun test` can import it (a
 * route file calls `createFileRoute` at module load and cannot be imported
 * by the test runner, the same reason `osint-summary.ts` exists separately
 * from `routes/osint.tsx`).
 */

export interface LayoutNode {
  id: string;
  x: number;
  y: number;
  /** Derived from degree (connection count), not asserted — a well-connected entity renders larger. */
  r: number;
  /** BFS distance from the root, or null if unreachable from it (still positioned, in the outermost ring — never dropped). */
  ring: number | null;
}

export interface LayoutResult {
  nodes: LayoutNode[];
  /** Count of entities with no path to the chosen root. */
  unreachedCount: number;
  /** The entity id actually used as ring 0, or null if there were no entities to lay out. */
  rootId: string | null;
}

export interface LayoutOptions {
  width?: number;
  height?: number;
  ringGap?: number;
  minRadius?: number;
  maxRadius?: number;
  /** Minimum center-to-center pixel spacing between two nodes sharing a ring — wide enough that their rendered labels don't collide. */
  minArcSpacing?: number;
}

const DEFAULTS: Required<LayoutOptions> = {
  width: 800,
  height: 560,
  ringGap: 85,
  minRadius: 10,
  maxRadius: 26,
  minArcSpacing: 92,
};

/**
 * Rough label-pixel-width estimate from character count. This module is
 * deliberately DOM-free (see the file header), so it cannot measure real font
 * metrics — this is a real bound derived from actual label content rather
 * than a flat guess, calibrated against `graph.tsx`'s own label rendering
 * (10px font, weight 600) and its 24-character truncation. It intentionally
 * errs wide: a slightly loose layout is a lesser fault than a colliding one.
 *
 * `minArcSpacing`/`ringGap` already guarantee separation for short labels
 * (an id, a short handle); this exists for the case they don't cover — two
 * nodes with long labels (an email address, a full URL) landing close enough
 * that the flat constants alone are no longer wide enough, e.g. a ring with
 * exactly one member sitting a fixed `ringGap` from a long-labelled root.
 */
const AVG_LABEL_CHAR_PX = 6.4;
/** Must match the truncation length in graph.tsx's label rendering. */
const MAX_LABEL_CHARS = 24;
const LABEL_PADDING_PX = 8;

function labelHalfWidth(displayName: string): number {
  return (Math.min(displayName.length, MAX_LABEL_CHARS) * AVG_LABEL_CHAR_PX) / 2;
}

/**
 * Places every entity on a ring by its BFS distance from `preferredRootId`
 * (or, if that id isn't among the entities, the first entity — never throws
 * for a missing root, since "the target itself wasn't returned as an
 * entity" is a real, survivable state, not an error).
 */
export function layoutRadial(
  entities: CollectorEntity[],
  relationships: CollectorRelationship[],
  preferredRootId: string | null,
  options: LayoutOptions = {},
): LayoutResult {
  const { width, height, ringGap, minRadius, maxRadius, minArcSpacing } = { ...DEFAULTS, ...options };
  const centerX = width / 2;
  const centerY = height / 2;

  if (entities.length === 0) {
    return { nodes: [], unreachedCount: 0, rootId: null };
  }

  const ids = new Set(entities.map((e) => e.id));
  const adjacency = new Map<string, Set<string>>();
  for (const e of entities) adjacency.set(e.id, new Set());
  for (const rel of relationships) {
    if (!ids.has(rel.sourceEntity) || !ids.has(rel.targetEntity)) continue;
    adjacency.get(rel.sourceEntity)!.add(rel.targetEntity);
    adjacency.get(rel.targetEntity)!.add(rel.sourceEntity);
  }

  const rootId = preferredRootId && ids.has(preferredRootId) ? preferredRootId : entities[0]!.id;

  const depth = new Map<string, number>();
  depth.set(rootId, 0);
  const queue: string[] = [rootId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const currentDepth = depth.get(current)!;
    for (const neighbor of adjacency.get(current) ?? []) {
      if (!depth.has(neighbor)) {
        depth.set(neighbor, currentDepth + 1);
        queue.push(neighbor);
      }
    }
  }

  const reachedMaxDepth = Math.max(0, ...[...depth.values()]);
  const unreachedRing = reachedMaxDepth + 1;

  const ringMembers = new Map<number, string[]>();
  for (const e of entities) {
    const ring = depth.get(e.id) ?? unreachedRing;
    if (!ringMembers.has(ring)) ringMembers.set(ring, []);
    ringMembers.get(ring)!.push(e.id);
  }

  const degree = new Map<string, number>();
  for (const [id, neighbors] of adjacency) degree.set(id, neighbors.size);
  const maxDegree = Math.max(1, ...[...degree.values()]);
  const radiusFor = (id: string): number => {
    // Every entity got an `adjacency` entry above, so `degree` always has one too — never undefined here.
    const d = degree.get(id)!;
    return minRadius + (maxRadius - minRadius) * (d / maxDegree);
  };

  const entityById = new Map(entities.map((e) => [e.id, e]));
  const maxLabelHalfWidthOf = (memberIds: string[]): number =>
    Math.max(0, ...memberIds.map((id) => labelHalfWidth(entityById.get(id)?.displayName ?? "")));

  // Ring radius must grow with *this ring's own member count*, not just its
  // BFS depth: a fixed `ring * ringGap` packs a busy ring's nodes so close
  // together that their real labels (rendered under each node) overlap —
  // exactly what happened when a target's ~25 "MENTIONED_IN" article
  // entities all landed one hop out, sharing a single narrow ring. Radius is
  // computed outward-cumulative (never less than the previous ring + gap,
  // so ring order still reads visually as "further = more hops"), boosted
  // to whatever this ring's own circumference needs to give each member at
  // least `minArcSpacing` px of its neighbors on the same ring.
  //
  // Neither `ringGap` nor `minArcSpacing` alone is enough once labels get
  // long: a ring with exactly one member (e.g. a single discovered account,
  // one hop from an email-address root) never benefits from the
  // circumference-based widening above — it lands at a fixed `ringGap` from
  // the root regardless of content, so a long root label and a long
  // one-member label collide even though the "busy ring" case above is
  // already handled. `labelHalfWidth` closes that gap from the two rings'
  // OWN content instead of a second flat constant, and is a floor under the
  // existing constants (`Math.max`), never a reduction of them — a graph of
  // short ids lays out exactly as before.
  const nodes: LayoutNode[] = [];
  const sortedRings = [...ringMembers.keys()].sort((a, b) => a - b);
  let previousRadius = 0;
  let previousRingLabelHalfWidth = 0;
  for (const ring of sortedRings) {
    const memberIds = ringMembers.get(ring)!;
    if (ring === 0) {
      nodes.push({
        id: memberIds[0]!,
        x: centerX,
        y: centerY,
        r: radiusFor(memberIds[0]!),
        ring: 0,
      });
      previousRadius = 0;
      previousRingLabelHalfWidth = maxLabelHalfWidthOf(memberIds);
      continue;
    }
    const thisRingLabelHalfWidth = maxLabelHalfWidthOf(memberIds);
    const radialGap = Math.max(
      ringGap,
      previousRingLabelHalfWidth + thisRingLabelHalfWidth + LABEL_PADDING_PX,
    );
    const arcSpacing = Math.max(minArcSpacing, 2 * thisRingLabelHalfWidth + LABEL_PADDING_PX);
    const requiredForSpacing = (memberIds.length * arcSpacing) / (2 * Math.PI);
    const radius = Math.max(previousRadius + radialGap, requiredForSpacing);
    previousRadius = radius;
    previousRingLabelHalfWidth = thisRingLabelHalfWidth;
    memberIds.forEach((id, i) => {
      const angle = (2 * Math.PI * i) / memberIds.length;
      nodes.push({
        id,
        x: centerX + radius * Math.cos(angle),
        y: centerY + radius * Math.sin(angle),
        r: radiusFor(id),
        ring: ring === unreachedRing ? null : ring,
      });
    });
  }

  return {
    nodes,
    unreachedCount: (ringMembers.get(unreachedRing) ?? []).length,
    rootId,
  };
}

export interface PathStep {
  entityId: string;
  /** The relationship connecting this step to the previous one; null on the first step (the path's start). */
  viaRelationship: RelationshipType | null;
}

/**
 * BFS shortest path between two entities, by hop count over the same
 * undirected adjacency `layoutRadial` builds — replaces the fixture's
 * hand-written "Vector-17 → Aster Motors" narration with a real traversal.
 * Returns null if either id is absent from `entities` or no path connects
 * them (never a guessed/partial route).
 *
 * When more than one relationship connects the same pair of entities, the
 * first one found labels that hop — real but not fully disambiguated, since
 * nothing downstream currently needs to distinguish "which of several edges."
 */
export function shortestPath(
  entities: CollectorEntity[],
  relationships: CollectorRelationship[],
  fromId: string,
  toId: string,
): PathStep[] | null {
  const ids = new Set(entities.map((e) => e.id));
  if (!ids.has(fromId) || !ids.has(toId)) return null;

  const adjacency = new Map<string, Set<string>>();
  for (const e of entities) adjacency.set(e.id, new Set());
  const edgeLabel = new Map<string, RelationshipType>();
  for (const rel of relationships) {
    if (!ids.has(rel.sourceEntity) || !ids.has(rel.targetEntity)) continue;
    adjacency.get(rel.sourceEntity)!.add(rel.targetEntity);
    adjacency.get(rel.targetEntity)!.add(rel.sourceEntity);
    const key = [rel.sourceEntity, rel.targetEntity].sort().join("|");
    if (!edgeLabel.has(key)) edgeLabel.set(key, rel.relationshipType);
  }

  if (fromId === toId) return [{ entityId: fromId, viaRelationship: null }];

  const predecessor = new Map<string, string>();
  const visited = new Set<string>([fromId]);
  const queue: string[] = [fromId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current === toId) break;
    for (const neighbor of adjacency.get(current) ?? []) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        predecessor.set(neighbor, current);
        queue.push(neighbor);
      }
    }
  }
  if (!visited.has(toId)) return null;

  const idsInPath: string[] = [toId];
  let cursor = toId;
  while (cursor !== fromId) {
    cursor = predecessor.get(cursor)!;
    idsInPath.push(cursor);
  }
  idsInPath.reverse();

  return idsInPath.map((id, i) => {
    if (i === 0) return { entityId: id, viaRelationship: null };
    const prev = idsInPath[i - 1]!;
    const key = [prev, id].sort().join("|");
    return { entityId: id, viaRelationship: edgeLabel.get(key) ?? null };
  });
}
