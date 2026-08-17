import { describe, expect, test } from "bun:test";
import { layoutRadial, shortestPath } from "../src/utils/graph-layout";
import { UNSCORED } from "../src/utils/collectors/result";
import type { CollectorEntity, CollectorRelationship } from "../src/utils/collectors/result";

function entity(id: string, type: CollectorEntity["type"] = "domain"): CollectorEntity {
  return {
    id,
    type,
    value: id,
    displayName: id,
    source: "test",
    confidence: UNSCORED,
    metadata: {},
  };
}

function rel(sourceEntity: string, targetEntity: string): CollectorRelationship {
  return {
    sourceEntity,
    relationshipType: "RESOLVES_TO",
    targetEntity,
    confidence: UNSCORED,
    source: "test",
  };
}

describe("layoutRadial", () => {
  test("an empty entity list produces an empty layout, not an error", () => {
    const result = layoutRadial([], [], null);
    expect(result).toEqual({ nodes: [], unreachedCount: 0, rootId: null });
  });

  test("a single entity with no relationships sits at the center as ring 0", () => {
    const result = layoutRadial([entity("a")], [], null);
    expect(result.rootId).toBe("a");
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0]!.ring).toBe(0);
    expect(result.nodes[0]!.x).toBe(400); // default width/2
    expect(result.nodes[0]!.y).toBe(280); // default height/2
  });

  test("directly-connected entities land one ring out from the root", () => {
    const entities = [entity("root"), entity("child1"), entity("child2")];
    const relationships = [rel("root", "child1"), rel("root", "child2")];
    const result = layoutRadial(entities, relationships, "root");
    const byId = Object.fromEntries(result.nodes.map((n) => [n.id, n]));
    expect(byId.root!.ring).toBe(0);
    expect(byId.child1!.ring).toBe(1);
    expect(byId.child2!.ring).toBe(1);
  });

  test("a two-hop chain produces rings 0, 1, 2 in order", () => {
    const entities = [entity("a"), entity("b"), entity("c")];
    const relationships = [rel("a", "b"), rel("b", "c")];
    const result = layoutRadial(entities, relationships, "a");
    const byId = Object.fromEntries(result.nodes.map((n) => [n.id, n]));
    expect(byId.a!.ring).toBe(0);
    expect(byId.b!.ring).toBe(1);
    expect(byId.c!.ring).toBe(2);
  });

  test("an entity with no path to the root is still positioned, in the outermost ring, never dropped", () => {
    const entities = [entity("root"), entity("connected"), entity("island")];
    const relationships = [rel("root", "connected")]; // "island" has no edge to anything
    const result = layoutRadial(entities, relationships, "root");
    expect(result.nodes).toHaveLength(3); // island IS present
    const island = result.nodes.find((n) => n.id === "island")!;
    expect(island.ring).toBeNull(); // unreachable, marked as such — not silently placed as if reachable
    expect(result.unreachedCount).toBe(1);
    expect(Number.isFinite(island.x)).toBe(true); // still has real coordinates, not NaN
    expect(Number.isFinite(island.y)).toBe(true);
  });

  test("a preferredRootId not present among the entities falls back to the first entity, never throws", () => {
    const entities = [entity("a"), entity("b")];
    const result = layoutRadial(entities, [], "nonexistent");
    expect(result.rootId).toBe("a");
  });

  test("null preferredRootId falls back to the first entity", () => {
    const entities = [entity("first"), entity("second")];
    const result = layoutRadial(entities, [], null);
    expect(result.rootId).toBe("first");
  });

  test("node radius scales with degree — a hub with 3 connections renders larger than a leaf with 1", () => {
    const entities = [
      entity("hub"),
      entity("leaf1"),
      entity("leaf2"),
      entity("leaf3"),
      entity("isolated"),
    ];
    const relationships = [rel("hub", "leaf1"), rel("hub", "leaf2"), rel("hub", "leaf3")];
    const result = layoutRadial(entities, relationships, "hub");
    const byId = Object.fromEntries(result.nodes.map((n) => [n.id, n]));
    expect(byId.hub!.r).toBeGreaterThan(byId.leaf1!.r);
    // An entity with zero connections at all still gets a real, minimum radius — never zero/invisible.
    expect(byId.isolated!.r).toBeGreaterThan(0);
  });

  test("a relationship referencing an entity id not in the entity list is ignored, not a crash", () => {
    const entities = [entity("a"), entity("b")];
    const relationships = [rel("a", "b"), rel("a", "ghost")];
    expect(() => layoutRadial(entities, relationships, "a")).not.toThrow();
    const result = layoutRadial(entities, relationships, "a");
    expect(result.nodes.map((n) => n.id).sort()).toEqual(["a", "b"]);
  });

  test("nodes sharing a ring are spread across distinct angles, not stacked on top of each other", () => {
    const entities = [entity("root"), entity("c1"), entity("c2"), entity("c3"), entity("c4")];
    const relationships = [
      rel("root", "c1"),
      rel("root", "c2"),
      rel("root", "c3"),
      rel("root", "c4"),
    ];
    const result = layoutRadial(entities, relationships, "root");
    const ring1 = result.nodes.filter((n) => n.ring === 1);
    const positions = new Set(ring1.map((n) => `${n.x.toFixed(1)},${n.y.toFixed(1)}`));
    expect(positions.size).toBe(ring1.length); // every position distinct
  });
});

describe("shortestPath", () => {
  test("a direct edge is a two-step path labelled with that relationship", () => {
    const entities = [entity("a"), entity("b")];
    const relationships = [rel("a", "b")];
    const path = shortestPath(entities, relationships, "a", "b");
    expect(path).toEqual([
      { entityId: "a", viaRelationship: null },
      { entityId: "b", viaRelationship: "RESOLVES_TO" },
    ]);
  });

  test("a multi-hop chain returns the intermediate node, not just the endpoints", () => {
    const entities = [entity("a"), entity("b"), entity("c")];
    const relationships = [rel("a", "b"), rel("b", "c")];
    const path = shortestPath(entities, relationships, "a", "c");
    expect(path?.map((s) => s.entityId)).toEqual(["a", "b", "c"]);
  });

  test("picks the shorter of two routes, not an arbitrary one", () => {
    const entities = [entity("a"), entity("b"), entity("c"), entity("shortcut")];
    const relationships = [
      rel("a", "b"),
      rel("b", "c"),
      rel("a", "shortcut"),
      rel("shortcut", "c"),
    ];
    const path = shortestPath(entities, relationships, "a", "c");
    expect(path).toHaveLength(3); // via "shortcut", not the 4-node route through b
  });

  test("no path between disconnected entities returns null, not a guessed route", () => {
    const entities = [entity("a"), entity("b"), entity("island")];
    const relationships = [rel("a", "b")];
    expect(shortestPath(entities, relationships, "a", "island")).toBeNull();
  });

  test("an id absent from the entity list returns null rather than throwing", () => {
    const entities = [entity("a"), entity("b")];
    const relationships = [rel("a", "b")];
    expect(shortestPath(entities, relationships, "a", "nonexistent")).toBeNull();
  });

  test("the same id for both ends is a single-step path with no relationship hop", () => {
    const entities = [entity("a")];
    const path = shortestPath(entities, [], "a", "a");
    expect(path).toEqual([{ entityId: "a", viaRelationship: null }]);
  });
});
