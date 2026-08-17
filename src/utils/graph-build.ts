/**
 * Entity co-occurrence graph — Module 2.
 *
 * `/graph` shipped a fixed ten-node topology written into the page: Vector-17,
 * Aster Motors, channel_9821, an @proton.me address and a masked phone number,
 * with literal x/y coordinates and ten hand-written relationships. There was no
 * fetch, no server function and no `useEffect` in the entire route. Beside it
 * sat a permanent "Selected node" card asserting `Risk score 88 / 100` and
 * `Connections 12` — a figure that contradicted the ten edges drawn above it —
 * and a prose-hardcoded "Shortest path".
 *
 * This module is the real thing, and it is pure: no DOM, no network, and no
 * `Math.random()`, so the same corpus always produces the same picture. A graph
 * that reshuffles between renders cannot be cited.
 *
 * The rules that make it honest:
 *
 *  - **An edge means "these two entities were named in the same article".**
 *    Nothing else. It is not a claim of association, funding, control or
 *    contact, and the UI must not label it as one.
 *  - **Every node and edge carries the article ids it came from.** A line the
 *    analyst cannot trace back to real text is a claim the system cannot
 *    support.
 *  - **Confidence is the maximum observed, never a mean.** Averaging two
 *    model-reported confidences produces a third number no model ever asserted
 *    — the same rule `entities.tsx` already follows.
 *  - **No risk score, no modularity, no "avg. degree".** Degree over a graph we
 *    actually built is computable and is reported. Modularity needs a walked
 *    follow graph, which this system does not have; `network.tsx` records what
 *    happened the last time one was printed anyway.
 */

import type { EntityType } from "../types/core";

/** The canonical vocabulary is `core.ts`'s. See `normaliseEntityType`. */
export const ENTITY_TYPES: EntityType[] = [
  "PERSON",
  "ORG",
  "LOCATION",
  "EVENT",
  "EQUIPMENT",
  "OTHER",
];

/**
 * Reconcile the three entity vocabularies that disagree in this codebase.
 *
 *   `llm.ts`      PERSON ORGANISATION LOCATION EQUIPMENT EVENT OTHER
 *   `core.ts`     PERSON ORG          LOCATION EVENT     EQUIPMENT OTHER  ← canonical
 *   old graph.tsx person org country domain phone email social  (lowercase)
 *
 * Anything unrecognised becomes OTHER rather than being dropped: an entity the
 * extractor found is real even when its label is one we do not model.
 */
export function normaliseEntityType(raw: string | null | undefined): EntityType {
  const t = String(raw ?? "")
    .trim()
    .toUpperCase();
  if (!t) return "OTHER";
  if (t === "ORGANISATION" || t === "ORGANIZATION" || t === "ORG") return "ORG";
  if (t === "PERSON" || t === "PEOPLE") return "PERSON";
  if (t === "LOCATION" || t === "PLACE" || t === "COUNTRY" || t === "CITY" || t === "GPE") {
    return "LOCATION";
  }
  if (t === "EVENT") return "EVENT";
  if (t === "EQUIPMENT" || t === "WEAPON" || t === "PLATFORM") return "EQUIPMENT";
  return "OTHER";
}

/**
 * Case- and punctuation-insensitive merge key, so "IAF" and "I.A.F." are one
 * node.
 *
 * Moved here from `entities.tsx`, unchanged. Read its history before touching
 * it: the class was once `[^a-z0-9ऀ-෿]`, which covers Devanagari
 * through Sinhala only. Urdu is written in Arabic script (U+0600–U+06FF) and is
 * one of this application's fifteen supported languages, so every Urdu entity
 * name was stripped to an empty key and silently merged into a single node.
 * `\p{L}\p{N}` keeps letters and digits in ANY script.
 */
export function entityKey(name: string): string {
  return name.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

export interface GraphEntityInput {
  entity: string;
  type: string;
  /** 0-1 as the extractor reported it. Never synthesised. */
  confidence: number;
}

export interface GraphArticleInput {
  id: string;
  /** Publisher. Used for the distinct-source count. */
  source: string;
  url?: string;
  /** Module 1 score for this article, or null when it could not be scored. */
  credibility?: number | null;
  entities: GraphEntityInput[];
}

export interface GraphNode {
  /** `${entityKey(name)}::${TYPE}` — the same key shape `entities.tsx` uses. */
  id: string;
  /** Display name: the first spelling seen for this key. */
  label: string;
  type: EntityType;
  /** Articles naming this entity. */
  articleIds: string[];
  /** Distinct publishers naming it. */
  sources: string[];
  /** Highest extractor confidence observed. Max, never a mean. */
  bestConfidence: number;
  /** Best Module 1 credibility among the naming articles, or null. */
  bestCredibility: number | null;
  /** Number of distinct entities co-mentioned with this one. */
  degree: number;
}

export interface GraphEdge {
  a: string;
  b: string;
  /** How many articles named BOTH endpoints. */
  weight: number;
  articleIds: string[];
}

export interface EntityGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Articles that contributed at least one entity. */
  articleCount: number;
  /**
   * How many distinct entities were found before the `maxNodes` cap.
   *
   * Reported so the UI can say "showing 250 of 613". A silently truncated graph
   * reads as the whole picture, which is the same class of error as any other
   * silent cap in this codebase — the analyst would conclude the corpus names
   * 250 entities when it names far more.
   */
  totalNodes: number;
  /** True when `maxNodes` removed something. */
  truncated: boolean;
}

/** Above this many nodes the layout is visibly slow, so it is the default cap. */
export const DEFAULT_MAX_NODES = 250;

export interface BuildOptions {
  /** Drop edges seen in fewer than this many articles. Default 1. */
  minWeight?: number;
  /** Drop nodes named in fewer than this many articles. Default 1. */
  minArticles?: number;
  /**
   * Keep at most this many nodes, highest degree first. Default 250.
   *
   * `layoutGraph` is O(n^2) per iteration, and `EntitiesSchema` permits 40
   * entities per article, so a 100-article corpus can reach several hundred
   * distinct nodes and freeze the tab. Truncation is always reported.
   */
  maxNodes?: number;
}

/**
 * Build the co-occurrence graph.
 *
 * Two entities are joined iff they appear in the same article. Self-pairs are
 * skipped, and an entity named twice in one article contributes that article
 * once — otherwise a repeated mention would inflate the edge weight into
 * something that looks like corroboration.
 */
export function buildEntityGraph(
  articles: GraphArticleInput[],
  opts: BuildOptions = {},
): EntityGraph {
  const minWeight = Math.max(1, opts.minWeight ?? 1);
  const minArticles = Math.max(1, opts.minArticles ?? 1);

  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  let articleCount = 0;

  for (const article of articles) {
    // Deduplicate within the article first. `keys` is what actually
    // participates in pairing.
    const keys: string[] = [];
    for (const e of article.entities ?? []) {
      const name = String(e.entity ?? "").trim();
      const key = entityKey(name);
      // An entity whose name is entirely punctuation has no key and cannot be
      // merged with anything. Dropping it is correct; merging it under "" would
      // fuse unrelated entities into one node.
      if (!key) continue;
      const type = normaliseEntityType(e.type);
      const id = `${key}::${type}`;

      const existing = nodes.get(id);
      const confidence = Number.isFinite(e.confidence) ? e.confidence : 0;
      const credibility = article.credibility ?? null;

      if (existing) {
        if (!existing.articleIds.includes(article.id)) existing.articleIds.push(article.id);
        if (article.source && !existing.sources.includes(article.source)) {
          existing.sources.push(article.source);
        }
        existing.bestConfidence = Math.max(existing.bestConfidence, confidence);
        if (credibility !== null) {
          existing.bestCredibility =
            existing.bestCredibility === null
              ? credibility
              : Math.max(existing.bestCredibility, credibility);
        }
      } else {
        nodes.set(id, {
          id,
          label: name,
          type,
          articleIds: [article.id],
          sources: article.source ? [article.source] : [],
          bestConfidence: confidence,
          bestCredibility: credibility,
          degree: 0,
        });
      }
      if (!keys.includes(id)) keys.push(id);
    }

    if (keys.length > 0) articleCount += 1;

    for (let i = 0; i < keys.length; i += 1) {
      for (let j = i + 1; j < keys.length; j += 1) {
        // Sorted pair id, so an edge is the same edge whichever order the
        // entities were extracted in.
        const [a, b] = keys[i] < keys[j] ? [keys[i], keys[j]] : [keys[j], keys[i]];
        const id = `${a}|${b}`;
        const found = edges.get(id);
        if (found) {
          if (!found.articleIds.includes(article.id)) {
            found.articleIds.push(article.id);
            found.weight += 1;
          }
        } else {
          edges.set(id, { a, b, weight: 1, articleIds: [article.id] });
        }
      }
    }
  }

  let keptNodes = [...nodes.values()].filter((n) => n.articleIds.length >= minArticles);
  const keptIds = new Set(keptNodes.map((n) => n.id));
  const keptEdges = [...edges.values()].filter(
    (e) => e.weight >= minWeight && keptIds.has(e.a) && keptIds.has(e.b),
  );

  // Degree over the edges that survived filtering, so the number on screen
  // always matches the lines drawn. The old page said "Connections 12" above ten
  // edges.
  const degrees = new Map<string, number>();
  for (const e of keptEdges) {
    degrees.set(e.a, (degrees.get(e.a) ?? 0) + 1);
    degrees.set(e.b, (degrees.get(e.b) ?? 0) + 1);
  }
  keptNodes = keptNodes.map((n) => ({ ...n, degree: degrees.get(n.id) ?? 0 }));

  keptNodes.sort(
    (x, y) =>
      y.degree - x.degree ||
      y.articleIds.length - x.articleIds.length ||
      x.label.localeCompare(y.label),
  );

  return { nodes: keptNodes, edges: keptEdges, articleCount };
}

/** Degree per node id, computed from the edge list. */
export function degreeCentrality(graph: EntityGraph): Map<string, number> {
  const out = new Map<string, number>();
  for (const n of graph.nodes) out.set(n.id, 0);
  for (const e of graph.edges) {
    out.set(e.a, (out.get(e.a) ?? 0) + 1);
    out.set(e.b, (out.get(e.b) ?? 0) + 1);
  }
  return out;
}

/**
 * Shortest path by hop count, or null when the two are not connected.
 *
 * Replaces a hardcoded two-hop route that named the same three fictional
 * entities on every load. "No path" is a real answer and must be shown as one —
 * an unconnected pair is a finding about the corpus.
 */
export function shortestPath(graph: EntityGraph, from: string, to: string): string[] | null {
  if (from === to) return graph.nodes.some((n) => n.id === from) ? [from] : null;

  const adjacency = new Map<string, string[]>();
  for (const n of graph.nodes) adjacency.set(n.id, []);
  for (const e of graph.edges) {
    adjacency.get(e.a)?.push(e.b);
    adjacency.get(e.b)?.push(e.a);
  }
  if (!adjacency.has(from) || !adjacency.has(to)) return null;

  const previous = new Map<string, string | null>([[from, null]]);
  const queue = [from];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (current === to) break;
    // Sorted, so the path returned is stable when several are equally short.
    for (const next of [...(adjacency.get(current) ?? [])].sort()) {
      if (previous.has(next)) continue;
      previous.set(next, current);
      queue.push(next);
    }
  }
  if (!previous.has(to)) return null;

  const path: string[] = [];
  let cursor: string | null = to;
  while (cursor !== null) {
    path.unshift(cursor);
    cursor = previous.get(cursor) ?? null;
  }
  return path;
}

export interface PositionedNode extends GraphNode {
  x: number;
  y: number;
}

export interface LayoutOptions {
  width?: number;
  height?: number;
  iterations?: number;
  padding?: number;
}

/**
 * Deterministic force-directed layout (Fruchterman–Reingold).
 *
 * Repulsion between every pair, spring attraction along edges, and a linear
 * cooling schedule. Initial positions are seeded **on a circle by index**, never
 * randomly: `Math.random()` is banned in this layer, and a layout that differs
 * between two renders of the same corpus cannot be pointed at in a report.
 *
 * Written by hand rather than pulling in d3-force or cytoscape — the same
 * decision as the DCT perceptual hash in `imaging.ts`. It is ~40 lines and adds
 * no dependency to a zero-budget, licence-audited build.
 */
export function layoutGraph(graph: EntityGraph, opts: LayoutOptions = {}): PositionedNode[] {
  const width = opts.width ?? 800;
  const height = opts.height ?? 560;
  const padding = opts.padding ?? 48;
  const iterations = opts.iterations ?? 300;
  const n = graph.nodes.length;
  if (n === 0) return [];

  const cx = width / 2;
  const cy = height / 2;
  if (n === 1) return [{ ...graph.nodes[0], x: cx, y: cy }];

  const area = (width - padding * 2) * (height - padding * 2);
  const k = Math.sqrt(area / n);

  const radius = Math.min(width, height) / 2 - padding;
  const pos = graph.nodes.map((node, i) => {
    const angle = (2 * Math.PI * i) / n;
    return { id: node.id, x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) };
  });
  const index = new Map(pos.map((p, i) => [p.id, i]));

  let temperature = Math.min(width, height) / 10;
  const cooling = temperature / (iterations + 1);

  for (let step = 0; step < iterations; step += 1) {
    const dx = new Array(n).fill(0);
    const dy = new Array(n).fill(0);

    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        let ex = pos[i].x - pos[j].x;
        let ey = pos[i].y - pos[j].y;
        let dist = Math.hypot(ex, ey);
        if (dist < 0.01) {
          // Perfectly coincident nodes would divide by zero. Nudge along a
          // deterministic axis derived from the indices, not a random one.
          ex = (i - j) % 2 === 0 ? 0.01 : -0.01;
          ey = 0.01;
          dist = Math.hypot(ex, ey);
        }
        const force = (k * k) / dist;
        const fx = (ex / dist) * force;
        const fy = (ey / dist) * force;
        dx[i] += fx;
        dy[i] += fy;
        dx[j] -= fx;
        dy[j] -= fy;
      }
    }

    for (const e of graph.edges) {
      const i = index.get(e.a);
      const j = index.get(e.b);
      if (i === undefined || j === undefined) continue;
      const ex = pos[i].x - pos[j].x;
      const ey = pos[i].y - pos[j].y;
      const dist = Math.max(0.01, Math.hypot(ex, ey));
      // Heavier edges pull harder: entities co-mentioned across many articles
      // sit closer together, which is the one thing the weight can honestly say.
      const force = ((dist * dist) / k) * Math.min(3, e.weight);
      const fx = (ex / dist) * force;
      const fy = (ey / dist) * force;
      dx[i] -= fx;
      dy[i] -= fy;
      dx[j] += fx;
      dy[j] += fy;
    }

    for (let i = 0; i < n; i += 1) {
      const disp = Math.max(0.01, Math.hypot(dx[i], dy[i]));
      pos[i].x += (dx[i] / disp) * Math.min(disp, temperature);
      pos[i].y += (dy[i] / disp) * Math.min(disp, temperature);
      pos[i].x = Math.min(width - padding, Math.max(padding, pos[i].x));
      pos[i].y = Math.min(height - padding, Math.max(padding, pos[i].y));
    }
    temperature = Math.max(0, temperature - cooling);
  }

  return graph.nodes.map((node, i) => ({
    ...node,
    // Rounded so two runs cannot differ in the last floating-point bit, which
    // would show up as a diff in any snapshot of the rendered SVG.
    x: Math.round(pos[i].x * 100) / 100,
    y: Math.round(pos[i].y * 100) / 100,
  }));
}

/** Marker radius from degree. Purely presentational; asserts nothing. */
export function nodeRadius(node: GraphNode): number {
  return Math.min(26, 9 + Math.sqrt(node.degree) * 4);
}

/**
 * What an edge does and does not mean, stated on screen.
 *
 * Co-occurrence is the weakest possible relationship claim, and a node-edge
 * diagram is very good at making weak claims look strong.
 */
export const COOCCURRENCE_CAVEAT =
  "An edge means the two entities were named in the same article. It is not a claim of " +
  "association, contact, control or funding — two names in one report may be unrelated. " +
  "Edge weight is the number of articles naming both.";
