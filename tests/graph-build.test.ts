import { describe, expect, test } from "bun:test";
import {
  buildEntityGraph,
  degreeCentrality,
  entityKey,
  layoutGraph,
  normaliseEntityType,
  shortestPath,
  COOCCURRENCE_CAVEAT,
  type GraphArticleInput,
} from "../src/utils/graph-build";

function article(id: string, source: string, names: [string, string][], cred?: number | null) {
  return {
    id,
    source,
    credibility: cred ?? null,
    entities: names.map(([entity, type]) => ({ entity, type, confidence: 0.8 })),
  } satisfies GraphArticleInput;
}

describe("normaliseEntityType", () => {
  test("reconciles the three vocabularies onto core.ts's", () => {
    // llm.ts says ORGANISATION, core.ts says ORG, the old graph page said "org".
    expect(normaliseEntityType("ORGANISATION")).toBe("ORG");
    expect(normaliseEntityType("ORGANIZATION")).toBe("ORG");
    expect(normaliseEntityType("org")).toBe("ORG");
    expect(normaliseEntityType("person")).toBe("PERSON");
    expect(normaliseEntityType("COUNTRY")).toBe("LOCATION");
    expect(normaliseEntityType("city")).toBe("LOCATION");
  });

  test("an unrecognised label becomes OTHER rather than being dropped", () => {
    // The entity is real even when its type label is one we do not model.
    expect(normaliseEntityType("VESSEL")).toBe("OTHER");
    expect(normaliseEntityType("")).toBe("OTHER");
    expect(normaliseEntityType(null)).toBe("OTHER");
    expect(normaliseEntityType(undefined)).toBe("OTHER");
  });
});

describe("entityKey", () => {
  test("merges case and punctuation variants", () => {
    expect(entityKey("I.A.F.")).toBe(entityKey("IAF"));
    expect(entityKey("Aster Motors")).toBe(entityKey("aster-motors"));
  });

  test("keeps letters and digits in ANY script", () => {
    // The old class covered U+0900-U+0DFF only, so every Urdu name (Arabic
    // script) was stripped to an empty key and merged into a single node.
    expect(entityKey("پاکستان")).not.toBe("");
    expect(entityKey("भारत")).not.toBe("");
    expect(entityKey("中国")).not.toBe("");
    expect(entityKey("پاکستان")).not.toBe(entityKey("भारत"));
  });

  test("a name of pure punctuation has no key", () => {
    expect(entityKey("!!!")).toBe("");
  });
});

describe("buildEntityGraph", () => {
  test("an edge exists only between entities named in the SAME article", () => {
    const g = buildEntityGraph([
      article("a1", "Reuters", [
        ["Alpha", "PERSON"],
        ["Beta", "ORG"],
      ]),
      article("a2", "AP", [["Gamma", "LOCATION"]]),
    ]);
    expect(g.nodes).toHaveLength(3);
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0].articleIds).toEqual(["a1"]);
  });

  test("edge weight counts co-mentioning ARTICLES, not mentions", () => {
    // An entity repeated inside one article must not inflate the weight into
    // something that reads as corroboration across sources.
    const g = buildEntityGraph([
      article("a1", "Reuters", [
        ["Alpha", "PERSON"],
        ["Alpha", "PERSON"],
        ["Beta", "ORG"],
      ]),
    ]);
    expect(g.edges).toHaveLength(1);
    expect(g.edges[0].weight).toBe(1);
  });

  test("weight rises with each additional co-mentioning article", () => {
    const pair: [string, string][] = [
      ["Alpha", "PERSON"],
      ["Beta", "ORG"],
    ];
    const g = buildEntityGraph([
      article("a1", "Reuters", pair),
      article("a2", "AP", pair),
      article("a3", "AFP", pair),
    ]);
    expect(g.edges[0].weight).toBe(3);
    expect(g.nodes[0].sources.sort()).toEqual(["AFP", "AP", "Reuters"]);
  });

  test("every node and edge carries the article ids it came from", () => {
    const g = buildEntityGraph([
      article("a1", "Reuters", [
        ["Alpha", "PERSON"],
        ["Beta", "ORG"],
      ]),
    ]);
    for (const n of g.nodes) expect(n.articleIds.length).toBeGreaterThan(0);
    for (const e of g.edges) expect(e.articleIds.length).toBeGreaterThan(0);
  });

  test("confidence and credibility are the MAX observed, never a mean", () => {
    const g = buildEntityGraph([
      {
        id: "a1",
        source: "Reuters",
        credibility: 0.4,
        entities: [{ entity: "Alpha", type: "PERSON", confidence: 0.3 }],
      },
      {
        id: "a2",
        source: "AP",
        credibility: 0.9,
        entities: [{ entity: "Alpha", type: "PERSON", confidence: 0.7 }],
      },
    ]);
    expect(g.nodes[0].bestConfidence).toBe(0.7);
    expect(g.nodes[0].bestCredibility).toBe(0.9);
  });

  test("credibility stays null when no naming article was scored", () => {
    const g = buildEntityGraph([article("a1", "Reuters", [["Alpha", "PERSON"]], null)]);
    expect(g.nodes[0].bestCredibility).toBeNull();
  });

  test("degree matches the edges actually drawn", () => {
    // The old page asserted "Connections 12" above ten hardcoded edges.
    const g = buildEntityGraph([
      article("a1", "Reuters", [
        ["Alpha", "PERSON"],
        ["Beta", "ORG"],
        ["Gamma", "LOCATION"],
      ]),
    ]);
    const alpha = g.nodes.find((n) => n.label === "Alpha")!;
    const drawn = g.edges.filter((e) => e.a === alpha.id || e.b === alpha.id).length;
    expect(alpha.degree).toBe(drawn);
    expect(alpha.degree).toBe(2);
  });

  test("same name, different type stays two nodes", () => {
    const g = buildEntityGraph([
      article("a1", "Reuters", [
        ["Jordan", "PERSON"],
        ["Jordan", "LOCATION"],
      ]),
    ]);
    expect(g.nodes).toHaveLength(2);
  });

  test("an unkeyable name is dropped rather than merged under an empty key", () => {
    const g = buildEntityGraph([
      article("a1", "Reuters", [
        ["!!!", "PERSON"],
        ["???", "ORG"],
        ["Alpha", "PERSON"],
      ]),
    ]);
    expect(g.nodes).toHaveLength(1);
    expect(g.nodes[0].label).toBe("Alpha");
  });

  test("an empty corpus produces an empty graph, not a placeholder", () => {
    const g = buildEntityGraph([]);
    expect(g).toEqual({ nodes: [], edges: [], articleCount: 0 });
  });

  test("minWeight drops weak edges and recomputes degree", () => {
    const g = buildEntityGraph(
      [
        article("a1", "Reuters", [
          ["Alpha", "PERSON"],
          ["Beta", "ORG"],
        ]),
        article("a2", "AP", [
          ["Alpha", "PERSON"],
          ["Beta", "ORG"],
        ]),
        article("a3", "AFP", [
          ["Alpha", "PERSON"],
          ["Gamma", "LOCATION"],
        ]),
      ],
      { minWeight: 2 },
    );
    expect(g.edges).toHaveLength(1);
    expect(g.nodes.find((n) => n.label === "Gamma")!.degree).toBe(0);
  });
});

describe("degreeCentrality", () => {
  test("counts incident edges per node", () => {
    const g = buildEntityGraph([
      article("a1", "Reuters", [
        ["Alpha", "PERSON"],
        ["Beta", "ORG"],
        ["Gamma", "LOCATION"],
      ]),
    ]);
    const d = degreeCentrality(g);
    for (const n of g.nodes) expect(d.get(n.id)).toBe(2);
  });
});

describe("shortestPath", () => {
  const chain = buildEntityGraph([
    article("a1", "Reuters", [
      ["Alpha", "PERSON"],
      ["Beta", "ORG"],
    ]),
    article("a2", "AP", [
      ["Beta", "ORG"],
      ["Gamma", "LOCATION"],
    ]),
  ]);
  const id = (label: string) => chain.nodes.find((n) => n.label === label)!.id;

  test("finds a real multi-hop route", () => {
    const p = shortestPath(chain, id("Alpha"), id("Gamma"));
    expect(p).not.toBeNull();
    expect(p!.map((x) => chain.nodes.find((n) => n.id === x)!.label)).toEqual([
      "Alpha",
      "Beta",
      "Gamma",
    ]);
  });

  test("returns null for unconnected entities rather than inventing a route", () => {
    const g = buildEntityGraph([
      article("a1", "Reuters", [
        ["Alpha", "PERSON"],
        ["Beta", "ORG"],
      ]),
      article("a2", "AP", [
        ["Delta", "PERSON"],
        ["Epsilon", "ORG"],
      ]),
    ]);
    const from = g.nodes.find((n) => n.label === "Alpha")!.id;
    const to = g.nodes.find((n) => n.label === "Delta")!.id;
    expect(shortestPath(g, from, to)).toBeNull();
  });

  test("an unknown node id yields null", () => {
    expect(shortestPath(chain, id("Alpha"), "not::A_NODE")).toBeNull();
  });
});

describe("layoutGraph", () => {
  const g = buildEntityGraph([
    article("a1", "Reuters", [
      ["Alpha", "PERSON"],
      ["Beta", "ORG"],
      ["Gamma", "LOCATION"],
    ]),
    article("a2", "AP", [
      ["Gamma", "LOCATION"],
      ["Delta", "EVENT"],
    ]),
  ]);

  test("is deterministic — the same corpus lays out identically every time", () => {
    // Math.random() is banned in this layer, and a graph that reshuffles between
    // renders cannot be pointed at in a report.
    const a = layoutGraph(g);
    const b = layoutGraph(g);
    expect(a.map((n) => [n.id, n.x, n.y])).toEqual(b.map((n) => [n.id, n.x, n.y]));
  });

  test("every node lands inside the viewport", () => {
    const out = layoutGraph(g, { width: 800, height: 560, padding: 48 });
    for (const n of out) {
      expect(n.x).toBeGreaterThanOrEqual(48);
      expect(n.x).toBeLessThanOrEqual(800 - 48);
      expect(n.y).toBeGreaterThanOrEqual(48);
      expect(n.y).toBeLessThanOrEqual(560 - 48);
    }
  });

  test("produces finite coordinates for every node", () => {
    for (const n of layoutGraph(g)) {
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.y)).toBe(true);
    }
  });

  test("handles the degenerate sizes", () => {
    expect(layoutGraph({ nodes: [], edges: [], articleCount: 0 })).toEqual([]);
    const one = buildEntityGraph([article("a1", "Reuters", [["Solo", "PERSON"]])]);
    const out = layoutGraph(one, { width: 800, height: 560 });
    expect(out).toHaveLength(1);
    expect(out[0].x).toBe(400);
    expect(out[0].y).toBe(280);
  });

  test("nodes do not land on top of each other", () => {
    const out = layoutGraph(g);
    for (let i = 0; i < out.length; i += 1) {
      for (let j = i + 1; j < out.length; j += 1) {
        expect(Math.hypot(out[i].x - out[j].x, out[i].y - out[j].y)).toBeGreaterThan(1);
      }
    }
  });
});

describe("COOCCURRENCE_CAVEAT", () => {
  test("states that an edge is not a claim of association", () => {
    expect(COOCCURRENCE_CAVEAT).toContain("not a claim of");
    expect(COOCCURRENCE_CAVEAT.toLowerCase()).toContain("same article");
  });
});
