import { describe, expect, test } from "bun:test";
import {
  csvEscape,
  MALTEGO_CSV_HEADERS,
  MALTEGO_TYPE,
  toMaltegoCsv,
} from "../src/utils/maltego-export";
import { UNSCORED } from "../src/utils/collectors/result";
import type {
  CollectorEntity,
  CollectorRelationship,
  EntityType,
  RelationshipType,
} from "../src/utils/collectors/result";

function entity(over: Partial<CollectorEntity> & { id: string }): CollectorEntity {
  return {
    type: "domain",
    value: over.id,
    displayName: over.id,
    source: "dns",
    confidence: UNSCORED,
    metadata: {},
    ...over,
  };
}

function rel(
  sourceEntity: string,
  relationshipType: RelationshipType,
  targetEntity: string,
  confidence = UNSCORED,
): CollectorRelationship {
  return { sourceEntity, relationshipType, targetEntity, confidence, source: "dns" };
}

function parseCsv(csv: string): string[][] {
  // Fixtures here never need embedded commas/quotes, so a plain split is
  // enough to verify structure without reimplementing a CSV parser.
  return csv.split("\r\n").map((line) => line.split(","));
}

describe("csvEscape", () => {
  test("leaves a plain value untouched", () => {
    expect(csvEscape("example.com")).toBe("example.com");
  });

  test("quotes a value containing a comma", () => {
    expect(csvEscape("a,b")).toBe('"a,b"');
  });

  test("quotes and doubles embedded quotes", () => {
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
  });

  test("quotes a value containing a newline", () => {
    expect(csvEscape("line1\nline2")).toBe('"line1\nline2"');
  });
});

describe("MALTEGO_TYPE", () => {
  test("every EntityType has a mapped Maltego type — no gaps", () => {
    const types: EntityType[] = [
      "person",
      "email",
      "phone",
      "username",
      "domain",
      "ip",
      "url",
      "location",
      "article",
      "image",
      "video",
      "organization",
      "social_account",
    ];
    for (const t of types) {
      expect(MALTEGO_TYPE[t]).toBeTruthy();
      expect(MALTEGO_TYPE[t]).toMatch(/^maltego\./);
    }
  });
});

describe("toMaltegoCsv", () => {
  test("empty input still produces a valid header-only CSV", () => {
    const csv = toMaltegoCsv([], []);
    expect(csv).toBe(MALTEGO_CSV_HEADERS.join(","));
  });

  test("an entity with no relationships gets exactly one row, target columns empty", () => {
    const csv = toMaltegoCsv([entity({ id: "example.com" })], []);
    const rows = parseCsv(csv);
    expect(rows).toHaveLength(2); // header + one entity row
    const row = rows[1]!;
    expect(row[0]).toBe("maltego.Domain"); // Source Maltego Type
    expect(row[1]).toBe("domain"); // Source Sentinel Type
    expect(row[2]).toBe("example.com"); // Source Value
    expect(row[5]).toBe(""); // Relationship
    expect(row[7]).toBe(""); // Target Maltego Type
    expect(row[9]).toBe(""); // Target Value
  });

  test("a relationship between two known entities becomes one fully-populated row", () => {
    const entities = [
      entity({ id: "a", type: "domain", value: "example.com", displayName: "example.com" }),
      entity({ id: "b", type: "ip", value: "93.184.216.34", displayName: "93.184.216.34" }),
    ];
    const relationships = [rel("a", "RESOLVES_TO", "b", { value: 0.9, reasons: ["live DNS"] })];
    const csv = toMaltegoCsv(entities, relationships);
    const rows = parseCsv(csv);
    expect(rows).toHaveLength(2); // header + one relationship row
    const row = rows[1]!;
    expect(row[0]).toBe("maltego.Domain");
    expect(row[2]).toBe("example.com");
    expect(row[5]).toBe("RESOLVES_TO");
    expect(row[6]).toBe("90%");
    expect(row[7]).toBe("maltego.IPv4Address");
    expect(row[9]).toBe("93.184.216.34");
  });

  test("unscored relationship confidence renders as an honest 'not scored', never a fabricated number", () => {
    const entities = [entity({ id: "a" }), entity({ id: "b" })];
    const csv = toMaltegoCsv(entities, [rel("a", "RESOLVES_TO", "b")]);
    const rows = parseCsv(csv);
    expect(rows[1]![6]).toBe("not scored");
  });

  test("a linked entity does not also get a separate standalone row", () => {
    const entities = [entity({ id: "a" }), entity({ id: "b" })];
    const csv = toMaltegoCsv(entities, [rel("a", "RESOLVES_TO", "b")]);
    const rows = parseCsv(csv);
    expect(rows).toHaveLength(2); // header + exactly the one relationship row, not 3
  });

  test("a relationship referencing an entity not in the entity list is skipped, not fabricated", () => {
    const entities = [entity({ id: "a" })];
    const csv = toMaltegoCsv(entities, [rel("a", "RESOLVES_TO", "ghost")]);
    const rows = parseCsv(csv);
    // "a" has no valid relationship, so it falls back to its own standalone row.
    expect(rows).toHaveLength(2);
    expect(rows[1]![5]).toBe(""); // no relationship emitted
  });

  test("a value containing a comma is properly quoted in the output", () => {
    const entities = [entity({ id: "a", type: "article", displayName: "Title, with a comma" })];
    const csv = toMaltegoCsv(entities, []);
    expect(csv).toContain('"Title, with a comma"');
  });

  test("mixed graph: some entities linked, some standalone", () => {
    const entities = [
      entity({ id: "root", type: "domain", value: "example.com" }),
      entity({ id: "ip1", type: "ip", value: "1.2.3.4" }),
      entity({ id: "orphan", type: "email", value: "x@example.com" }),
    ];
    const relationships = [rel("root", "RESOLVES_TO", "ip1")];
    const rows = parseCsv(toMaltegoCsv(entities, relationships));
    expect(rows).toHaveLength(3); // header + 1 relationship row + 1 standalone row
    const standalone = rows.find((r) => r[2] === "x@example.com");
    expect(standalone).toBeDefined();
    expect(standalone![7]).toBe(""); // target columns empty
  });
});
