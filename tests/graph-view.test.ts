import { describe, expect, it } from "bun:test";

import {
  MAX_RENDERED_NODES,
  colourFor,
  emptyView,
  investigationRootId,
  matchNodes,
  pathBetween,
  typeLegend,
  viewFromCorpus,
  viewFromInvestigation,
} from "../src/utils/graph-view";
import type { GraphSnapshot } from "../src/utils/graph-store";
import { buildEntityGraph } from "../src/utils/graph-build";
import { UNSCORED, type CollectorEntity, type CollectorRelationship } from "../src/utils/collectors/result";

/**
 * `/graph` renders two different analyses through one view model. These pin the
 * properties that make that safe — above all that neither source acquires a
 * claim the other's data supports but its own does not.
 */

// ─── Fixtures ──────────────────────────────────────────────────────────────

function entity(over: Partial<CollectorEntity> = {}): CollectorEntity {
  return {
    id: "e1",
    type: "domain",
    value: "example.com",
    displayName: "example.com",
    source: "dns",
    confidence: UNSCORED,
    metadata: {},
    ...over,
  };
}

function snapshot(over: Partial<GraphSnapshot> = {}): GraphSnapshot {
  return {
    investigationId: "INV-1001",
    target: "example.com",
    savedAt: "2026-08-17T10:00:00.000Z",
    entities: [
      entity({ id: "root", value: "example.com", displayName: "example.com" }),
      entity({ id: "ip1", type: "ip", value: "203.0.113.7", displayName: "203.0.113.7" }),
      entity({ id: "mail", type: "email", value: "a@example.com", displayName: "a@example.com" }),
    ],
    relationships: [
      { sourceEntity: "root", relationshipType: "RESOLVES_TO", targetEntity: "ip1", confidence: UNSCORED, source: "dns" },
      { sourceEntity: "root", relationshipType: "HAS_EMAIL", targetEntity: "mail", confidence: UNSCORED, source: "dns" },
    ] as CollectorRelationship[],
    ...over,
  };
}

const corpusArticles = [
  {
    id: "a1",
    source: "Reuters",
    url: "https://example.com/1",
    credibility: 0.8,
    entities: [
      { entity: "Rajesh Kumar", type: "PERSON", confidence: 0.9 },
      { entity: "Bengaluru", type: "LOCATION", confidence: 0.8 },
    ],
  },
  {
    id: "a2",
    source: "PTI",
    url: "https://example.com/2",
    credibility: null,
    entities: [
      { entity: "Rajesh Kumar", type: "PERSON", confidence: 0.7 },
      { entity: "HAL", type: "ORG", confidence: 0.85 },
    ],
  },
];

// ─── Investigation source ──────────────────────────────────────────────────

describe("viewFromInvestigation", () => {
  const view = viewFromInvestigation(snapshot());

  it("keeps origin's essential concepts: a root and rings", () => {
    expect(view.source).toBe("investigation");
    expect(view.rootId).toBe("root");
    expect(view.nodes.find((n) => n.id === "root")?.ring).toBe(0);
  });

  it("carries collector provenance into the detail rows", () => {
    const node = view.nodes.find((n) => n.id === "ip1");
    const labels = node!.facts.map((f) => f.label);
    expect(labels).toContain("Value");
    expect(labels).toContain("Collector");
    expect(labels).toContain("Confidence");
  });

  it("renders an unscored confidence as 'not scored', never 0.00", () => {
    // `confidence.value` is null until something computes it. Showing 0.00
    // would turn "nobody scored this" into "scored, and worthless".
    const node = view.nodes[0];
    const conf = node.facts.find((f) => f.label === "Confidence");
    expect(conf?.value).toBe("not scored");
  });

  it("labels its edges with the relationship type", () => {
    expect(view.edges.map((e) => e.label).sort()).toEqual(["HAS_EMAIL", "RESOLVES_TO"]);
  });

  it("leaves edge weight null — collector edges carry no strength", () => {
    // A thickness derived from a weight nobody measured would be a fabricated
    // signal, so the renderer must be told there is none.
    expect(view.edges.every((e) => e.weight === null)).toBe(true);
  });

  it("is Maltego-exportable", () => {
    expect(view.maltegoExportable).toBe(true);
  });

  it("reports truncation instead of silently capping", () => {
    const many = snapshot({
      entities: Array.from({ length: MAX_RENDERED_NODES + 40 }, (_, i) =>
        entity({ id: `e${i}`, value: `h${i}.example.com`, displayName: `h${i}` }),
      ),
      relationships: [],
    });
    const v = viewFromInvestigation(many);
    expect(v.nodes.length).toBe(MAX_RENDERED_NODES);
    expect(v.totalNodes).toBe(MAX_RENDERED_NODES + 40);
    expect(v.truncated).toBe(true);
  });

  it("survives a target that was not returned as an entity", () => {
    const v = viewFromInvestigation(snapshot({ target: "never-collected.example" }));
    expect(v.rootId).toBeNull();
    expect(v.nodes.length).toBeGreaterThan(0);
  });
});

// ─── Corpus source ─────────────────────────────────────────────────────────

describe("viewFromCorpus", () => {
  const graph = buildEntityGraph(corpusArticles as never);
  const view = viewFromCorpus(graph);

  it("produces a rootless, ringless graph", () => {
    // Co-occurrence has no privileged entity. A ring of 0 would assert a
    // distance from a root that does not exist.
    expect(view.source).toBe("corpus");
    expect(view.rootId).toBeNull();
    expect(view.unreachedCount).toBeNull();
    expect(view.nodes.every((n) => n.ring === null)).toBe(true);
  });

  it("weights edges by co-occurrence and leaves them unlabelled", () => {
    expect(view.edges.every((e) => e.label === null)).toBe(true);
    expect(view.edges.every((e) => typeof e.weight === "number")).toBe(true);
  });

  it("carries the co-occurrence caveat", () => {
    expect(view.caveat).toBeTruthy();
  });

  it("is NOT Maltego-exportable, because the vocabularies do not map", () => {
    // EVENT / EQUIPMENT / OTHER have no collector-side equivalent, and
    // MALTEGO_TYPE is keyed on the collector enum. Exporting would mean
    // assigning a type nobody measured.
    expect(view.maltegoExportable).toBe(false);
  });

  it("reports an unscored credibility as 'not scored'", () => {
    const hal = view.nodes.find((n) => n.label === "HAL");
    const cred = hal!.facts.find((f) => f.label === "Best source credibility");
    expect(cred?.value).toBe("not scored");
  });

  it("keeps article and publisher counts as the node's evidence", () => {
    const rajesh = view.nodes.find((n) => n.label === "Rajesh Kumar");
    expect(rajesh!.facts.find((f) => f.label === "Articles")?.value).toBe("2");
    expect(rajesh!.facts.find((f) => f.label === "Distinct publishers")?.value).toBe("2");
  });
});

// ─── Shared operations ─────────────────────────────────────────────────────

describe("the two sources never borrow each other's claims", () => {
  const inv = viewFromInvestigation(snapshot());
  const cor = viewFromCorpus(buildEntityGraph(corpusArticles as never));

  it("only the investigation has a root", () => {
    expect(inv.rootId).not.toBeNull();
    expect(cor.rootId).toBeNull();
  });

  it("only the corpus carries a methodological caveat", () => {
    expect(inv.caveat).toBeNull();
    expect(cor.caveat).toBeTruthy();
  });

  it("type ids are never compared across sources", () => {
    // Both vocabularies coexist; the colour lookup must not fall through to a
    // neighbouring source's hue table.
    expect(colourFor(inv, "domain")).not.toBe(colourFor(cor, "domain"));
    expect(colourFor(cor, "PERSON")).toBeTruthy();
  });
});

describe("matchNodes", () => {
  const view = viewFromInvestigation(snapshot());

  it("returns everything for an empty query", () => {
    expect(matchNodes(view, "  ").size).toBe(view.nodes.length);
  });

  it("matches on label, value and type", () => {
    expect(matchNodes(view, "203.0").size).toBe(1);
    expect(matchNodes(view, "email").size).toBe(1);
  });

  it("returns an empty set rather than everything when nothing matches", () => {
    expect(matchNodes(view, "zzzz-no-such-entity").size).toBe(0);
  });
});

describe("pathBetween", () => {
  const snap = snapshot();
  const inv = viewFromInvestigation(snap);

  it("returns investigation hops with the relationship traversed", () => {
    const path = pathBetween(inv, { entities: snap.entities, relationships: snap.relationships }, "ip1", "root");
    expect(path).not.toBeNull();
    expect(path!.map((s) => s.id)).toContain("root");
    // The edge label is what makes the path readable; dropping it was a real
    // regression risk when unifying the two return shapes.
    expect(path!.some((s) => s.via !== null)).toBe(true);
  });

  it("returns corpus hops with a null relationship rather than an invented one", () => {
    const graph = buildEntityGraph(corpusArticles as never);
    const cor = viewFromCorpus(graph);
    const ids = cor.nodes.map((n) => n.id);
    const path = pathBetween(cor, graph, ids[0], ids[1]);
    if (path) expect(path.every((s) => s.via === null)).toBe(true);
  });

  it("returns null when there is no path — a finding, not an error", () => {
    const isolated = snapshot({
      entities: [entity({ id: "a" }), entity({ id: "b", value: "other.example" })],
      relationships: [],
    });
    const v = viewFromInvestigation(isolated);
    expect(pathBetween(v, { entities: isolated.entities, relationships: isolated.relationships }, "a", "b")).toBeNull();
  });
});

describe("typeLegend", () => {
  it("lists only types actually present, most frequent first", () => {
    const view = viewFromInvestigation(snapshot());
    const legend = typeLegend(view);
    expect(legend.map((l) => l.typeId).sort()).toEqual(["domain", "email", "ip"]);
    expect(legend[0].count).toBeGreaterThanOrEqual(legend[legend.length - 1].count);
  });
});

describe("emptyView", () => {
  it("is renderable without null checks and keeps per-source traits", () => {
    expect(emptyView("investigation").maltegoExportable).toBe(true);
    expect(emptyView("corpus").maltegoExportable).toBe(false);
    expect(emptyView("corpus").caveat).toBeTruthy();
    expect(emptyView("investigation").nodes).toEqual([]);
  });
});
