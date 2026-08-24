import { describe, expect, test } from "bun:test";
import {
  dedupeEntitiesById,
  dedupeRelationships,
  mergeTargetSelfEntities,
} from "../src/utils/osint/merge";
import { UNSCORED, type CollectorEntity, type CollectorRelationship } from "../src/utils/collectors/result";

function person(id: string, source: string, value = "Ankit Bhatt"): CollectorEntity {
  return {
    id,
    type: "person",
    value,
    displayName: value,
    source,
    confidence: UNSCORED,
    metadata: { [source]: true },
  };
}

function article(id: string, source: string): CollectorEntity {
  return {
    id,
    type: "article",
    value: `https://example.com/${id}`,
    displayName: id,
    source,
    confidence: UNSCORED,
    metadata: {},
  };
}

describe("dedupeEntitiesById / dedupeRelationships", () => {
  test("keeps the first entity seen for a repeated id", () => {
    const a = person("dorks:target:Ankit Bhatt", "dorks");
    const b = person("dorks:target:Ankit Bhatt", "dorks", "Different Value");
    expect(dedupeEntitiesById([a, b])).toEqual([a]);
  });

  test("keys relationships on the full edge tuple including source", () => {
    const r1: CollectorRelationship = {
      sourceEntity: "a",
      relationshipType: "MENTIONED_IN",
      targetEntity: "b",
      confidence: UNSCORED,
      source: "dorks",
    };
    const r2 = { ...r1, source: "news" };
    expect(dedupeRelationships([r1, r1, r2])).toHaveLength(2);
  });
});

describe("mergeTargetSelfEntities — collapses each collector's own target-placeholder entity", () => {
  test("three collectors' own target entities for the same investigation become one node", () => {
    const entities = [
      person("dorks:target:Ankit Bhatt", "dorks"),
      person("identity.websearch:target:Ankit Bhatt", "identity.websearch"),
      person("social:target:Ankit Bhatt", "social"),
      article("dorks:article:https://example.com/1", "dorks"),
    ];
    const relationships: CollectorRelationship[] = [
      { sourceEntity: "dorks:target:Ankit Bhatt", relationshipType: "MENTIONED_IN", targetEntity: "dorks:article:https://example.com/1", confidence: UNSCORED, source: "dorks" },
      { sourceEntity: "identity.websearch:target:Ankit Bhatt", relationshipType: "WORKS_AT", targetEntity: "org:1", confidence: UNSCORED, source: "identity.websearch" },
    ];

    const result = mergeTargetSelfEntities(entities, relationships, "Ankit Bhatt");

    const personEntities = result.entities.filter((e) => e.type === "person");
    expect(personEntities).toHaveLength(1);
    expect(personEntities[0]!.id).toBe("target:ankit bhatt");
    expect(result.entities).toHaveLength(2); // 1 merged person + the untouched article

    // Both relationships that pointed at a duplicate now point at the canonical id.
    expect(result.relationships.every((r) => r.sourceEntity === "target:ankit bhatt" || r.sourceEntity === "org:1")).toBe(true);
  });

  test("is case- and whitespace-insensitive when matching the target value", () => {
    const entities = [person("dorks:target:  ankit bhatt  ", "dorks"), person("social:target:Ankit Bhatt", "social")];
    const result = mergeTargetSelfEntities(entities, [], "Ankit Bhatt");
    expect(result.entities.filter((e) => e.type === "person")).toHaveLength(1);
  });

  test("a lone target entity (no duplicates) is left completely untouched", () => {
    const entities = [person("dorks:target:Ankit Bhatt", "dorks")];
    const result = mergeTargetSelfEntities(entities, [], "Ankit Bhatt");
    expect(result.entities).toEqual(entities);
  });

  test("never merges an entity for a DIFFERENT target that happens to match the id shape", () => {
    const entities = [person("dorks:target:Ankit Bhatt", "dorks"), person("social:target:Someone Else", "social", "Someone Else")];
    const result = mergeTargetSelfEntities(entities, [], "Ankit Bhatt");
    expect(result.entities).toHaveLength(2);
  });

  test("a relationship that becomes a self-loop after remapping is dropped, not kept asserting nothing", () => {
    const entities = [person("dorks:target:Ankit Bhatt", "dorks"), person("social:target:Ankit Bhatt", "social")];
    const relationships: CollectorRelationship[] = [
      { sourceEntity: "dorks:target:Ankit Bhatt", relationshipType: "MENTIONED_IN", targetEntity: "social:target:Ankit Bhatt", confidence: UNSCORED, source: "dorks" },
    ];
    const result = mergeTargetSelfEntities(entities, relationships, "Ankit Bhatt");
    expect(result.relationships).toHaveLength(0);
  });

  test("merged entity records which collectors contributed, in metadata.mergedFrom", () => {
    const entities = [person("dorks:target:Ankit Bhatt", "dorks"), person("social:target:Ankit Bhatt", "social")];
    const result = mergeTargetSelfEntities(entities, [], "Ankit Bhatt");
    const merged = result.entities.find((e) => e.type === "person")!;
    expect(merged.metadata.mergedFrom).toEqual(["dorks", "social"]);
  });

  test("stays UNSCORED — this is self-reference bookkeeping, not independently corroborated evidence", () => {
    const entities = [person("dorks:target:Ankit Bhatt", "dorks"), person("social:target:Ankit Bhatt", "social")];
    const result = mergeTargetSelfEntities(entities, [], "Ankit Bhatt");
    const merged = result.entities.find((e) => e.type === "person")!;
    expect(merged.confidence).toEqual(UNSCORED);
  });

  test("entities that are not the same target's :target: id (e.g. a discovered mention) are never touched", () => {
    const entities = [
      person("dorks:target:Ankit Bhatt", "dorks"),
      person("social:target:Ankit Bhatt", "social"),
      person("dorks:person:john-smith", "dorks", "John Smith"),
    ];
    const result = mergeTargetSelfEntities(entities, [], "Ankit Bhatt");
    expect(result.entities.some((e) => e.id === "dorks:person:john-smith")).toBe(true);
  });
});
