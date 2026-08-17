import { describe, expect, test } from "bun:test";
import {
  computeMergeConfidence,
  normalizeDomain,
  normalizeEmail,
  normalizeEntityValue,
  normalizeUrl,
  normalizeUsername,
  resolveEntities,
  resolveInvestigationEntities,
} from "../src/utils/osint/entity-resolution";
import { UNSCORED } from "../src/utils/collectors/result";
import type { CollectorEntity, CollectorRelationship } from "../src/utils/collectors/result";

function entity(overrides: Partial<CollectorEntity>): CollectorEntity {
  return {
    id: "id",
    type: "domain",
    value: "example.com",
    displayName: "example.com",
    source: "dns",
    confidence: UNSCORED,
    metadata: {},
    ...overrides,
  };
}

describe("normalizers", () => {
  test("normalizeEmail lowercases and trims", () => {
    expect(normalizeEmail("  John@Example.COM ")).toBe("john@example.com");
  });

  test("normalizeDomain lowercases and strips a trailing dot, but keeps www (a different DNS name)", () => {
    expect(normalizeDomain("Example.com.")).toBe("example.com");
    expect(normalizeDomain("www.example.com")).toBe("www.example.com");
  });

  test("normalizeUsername strips a leading @ and lowercases", () => {
    expect(normalizeUsername("@JohnSmith")).toBe("johnsmith");
  });

  test("normalizeUrl lowercases scheme+host, drops the fragment and a bare trailing slash, keeps the query", () => {
    expect(normalizeUrl("HTTPS://Example.com/Path/?q=1#frag")).toBe("https://example.com/Path?q=1");
    expect(normalizeUrl("https://example.com/")).toBe("https://example.com");
  });

  test("normalizeUrl falls back to a trimmed lowercase string for an unparseable value, never throws", () => {
    expect(normalizeUrl("not a url")).toBe("not a url");
  });

  test("normalizeEntityValue dispatches by type and falls back to generic trim+lowercase for ip/phone/etc.", () => {
    expect(normalizeEntityValue("ip", " 1.2.3.4 ")).toBe("1.2.3.4");
    expect(normalizeEntityValue("email", "A@B.com")).toBe("a@b.com");
  });
});

describe("computeMergeConfidence", () => {
  test("a single source is UNSCORED — nothing corroborates it", () => {
    expect(computeMergeConfidence("domain", ["dns"])).toEqual(UNSCORED);
  });

  test("multiple sources produce a score with explaining reasons (plan §18), never a bare number", () => {
    const score = computeMergeConfidence("domain", ["dns", "rdap", "crtsh"]);
    expect(score.value).not.toBeNull();
    expect(score.reasons.length).toBeGreaterThan(0);
    expect(score.reasons.join(" ")).toContain("dns");
  });

  test("duplicate source names in the input don't inflate the score", () => {
    const scoreDup = computeMergeConfidence("domain", ["dns", "dns"]);
    expect(scoreDup).toEqual(UNSCORED); // de-duped to one real source
  });
});

describe("resolveEntities — the core §17 guarantee", () => {
  test("three collectors reporting the same email become ONE entity, not three (plan §17's own example)", () => {
    const entities = [
      entity({
        id: "spiderfoot:email:john@example.com",
        type: "email",
        value: "john@example.com",
        source: "spiderfoot",
      }),
      entity({
        id: "theharvester:email:john@example.com",
        type: "email",
        value: "john@example.com",
        source: "theharvester",
      }),
      entity({
        id: "dorks:email:john@example.com",
        type: "email",
        value: "john@example.com",
        source: "dorks",
      }),
    ];
    const resolved = resolveEntities(entities, []);
    expect(resolved.entities).toHaveLength(1);
    expect(resolved.entities[0]!.value).toBe("john@example.com");
    expect(resolved.entities[0]!.metadata.mergedFrom).toEqual([
      "dorks",
      "spiderfoot",
      "theharvester",
    ]);
  });

  test("case and formatting differences still merge once normalized", () => {
    const entities = [
      entity({ id: "a:1", type: "email", value: "John@Example.com", source: "a" }),
      entity({ id: "b:1", type: "email", value: "john@example.com", source: "b" }),
    ];
    const resolved = resolveEntities(entities, []);
    expect(resolved.entities).toHaveLength(1);
  });

  test("different entity types with the same string value are never merged into each other", () => {
    const entities = [
      entity({ id: "a:1", type: "username", value: "example.com", source: "a" }),
      entity({ id: "b:1", type: "domain", value: "example.com", source: "b" }),
    ];
    const resolved = resolveEntities(entities, []);
    expect(resolved.entities).toHaveLength(2);
  });

  test("a single-source entity passes through unchanged, not wrapped in a pointless merge", () => {
    const only = entity({
      id: "dns:domain:example.com",
      type: "domain",
      value: "example.com",
      source: "dns",
    });
    const resolved = resolveEntities([only], []);
    expect(resolved.entities).toEqual([only]);
    expect(resolved.idRemap.size).toBe(0);
  });

  test("relationships pointing at merged entities are rewritten to the merged id", () => {
    const entities = [
      entity({ id: "dns:ip:1.2.3.4", type: "ip", value: "1.2.3.4", source: "dns" }),
      entity({
        id: "shodan:ip:1.2.3.4",
        type: "ip",
        value: "1.2.3.4",
        source: "shodan-internetdb",
      }),
      entity({ id: "dns:domain:example.com", type: "domain", value: "example.com", source: "dns" }),
    ];
    const relationships: CollectorRelationship[] = [
      {
        sourceEntity: "dns:domain:example.com",
        relationshipType: "RESOLVES_TO",
        targetEntity: "dns:ip:1.2.3.4",
        confidence: UNSCORED,
        source: "dns",
      },
    ];
    const resolved = resolveEntities(entities, relationships);
    const mergedIpId = resolved.entities.find((e) => e.type === "ip")!.id;
    expect(resolved.relationships[0]!.targetEntity).toBe(mergedIpId);
    expect(resolved.idRemap.get("dns:ip:1.2.3.4")).toBe(mergedIpId);
    expect(resolved.idRemap.get("shodan:ip:1.2.3.4")).toBe(mergedIpId);
  });

  test("a relationship that becomes a self-loop after remapping is dropped, not kept as a meaningless edge", () => {
    const entities = [
      entity({ id: "a:email:x@example.com", type: "email", value: "x@example.com", source: "a" }),
      entity({ id: "b:email:x@example.com", type: "email", value: "x@example.com", source: "b" }),
    ];
    const relationships: CollectorRelationship[] = [
      {
        sourceEntity: "a:email:x@example.com",
        relationshipType: "HAS_EMAIL",
        targetEntity: "b:email:x@example.com",
        confidence: UNSCORED,
        source: "a",
      },
    ];
    const resolved = resolveEntities(entities, relationships);
    expect(resolved.relationships).toEqual([]);
  });

  test("duplicate relationships produced by the remap collapse via the shared exact-edge dedup", () => {
    const entities = [
      entity({ id: "dns:domain:example.com", type: "domain", value: "example.com", source: "dns" }),
      entity({
        id: "rdap:domain:example.com",
        type: "domain",
        value: "example.com",
        source: "rdap",
      }),
      entity({ id: "target:ip:1.2.3.4", type: "ip", value: "1.2.3.4", source: "dns" }),
    ];
    const relationships: CollectorRelationship[] = [
      {
        sourceEntity: "dns:domain:example.com",
        relationshipType: "RESOLVES_TO",
        targetEntity: "target:ip:1.2.3.4",
        confidence: UNSCORED,
        source: "dns",
      },
      {
        sourceEntity: "rdap:domain:example.com",
        relationshipType: "RESOLVES_TO",
        targetEntity: "target:ip:1.2.3.4",
        confidence: UNSCORED,
        source: "dns",
      },
    ];
    const resolved = resolveEntities(entities, relationships);
    expect(resolved.relationships).toHaveLength(1);
  });
});

describe("resolveEntities — person/organization are never merged by name (the plan §18 guarantee)", () => {
  test("two 'John Smith' person entities from different collectors stay separate, full stop", () => {
    const entities = [
      entity({
        id: "dorks:target:John Smith",
        type: "person",
        value: "John Smith",
        source: "dorks",
      }),
      entity({ id: "news:target:John Smith", type: "person", value: "John Smith", source: "news" }),
    ];
    const resolved = resolveEntities(entities, []);
    expect(resolved.entities).toHaveLength(2);
    expect(resolved.idRemap.size).toBe(0);
  });

  test("organization entities with the same name are likewise never merged", () => {
    const entities = [
      entity({
        id: "a:org:Example Corp",
        type: "organization",
        value: "Example Corp",
        source: "a",
      }),
      entity({
        id: "b:org:Example Corp",
        type: "organization",
        value: "Example Corp",
        source: "b",
      }),
    ];
    const resolved = resolveEntities(entities, []);
    expect(resolved.entities).toHaveLength(2);
  });
});

describe("resolveInvestigationEntities", () => {
  test("replaces entities/relationships but passes every other field through untouched", () => {
    const investigation = {
      input: "example.com",
      entities: [
        entity({ id: "a:domain:example.com", type: "domain", value: "example.com", source: "a" }),
        entity({ id: "b:domain:example.com", type: "domain", value: "example.com", source: "b" }),
      ],
      relationships: [] as CollectorRelationship[],
      evidence: [
        {
          source: "a",
          sourceUrl: null,
          collector: "a",
          collectedAt: "2026-08-14T00:00:00Z",
          rawValue: {},
          normalizedValue: {},
          confidence: null,
          metadata: {},
        },
      ],
      warnings: ["a warning"],
      errors: [] as string[],
    };
    const resolved = resolveInvestigationEntities(investigation);
    expect(resolved.entities).toHaveLength(1);
    expect(resolved.evidence).toBe(investigation.evidence); // untouched, same reference
    expect(resolved.warnings).toEqual(["a warning"]);
    expect(resolved.input).toBe("example.com");
  });
});
