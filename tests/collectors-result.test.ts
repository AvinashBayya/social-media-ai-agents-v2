import { describe, expect, test } from "bun:test";
import {
  ConfidenceScoreSchema,
  CollectorEntitySchema,
  CollectorEvidenceSchema,
  CollectorExecutionMetaSchema,
  CollectorRelationshipSchema,
  InvestigationResultSchema,
  InvestigationResultValidationError,
  UNSCORED,
  emptyInvestigationResult,
  parseInvestigationResult,
} from "../src/utils/collectors/result";

const COMPLETED_EXECUTION = {
  status: "completed" as const,
  startedAt: "2026-08-14T00:00:00.000Z",
  completedAt: "2026-08-14T00:00:01.000Z",
  durationMs: 1000,
  resultCount: 0,
  error: null,
};

describe("ConfidenceScoreSchema", () => {
  test("accepts a null value with reasons — the 'not computed' state", () => {
    expect(() => ConfidenceScoreSchema.parse(UNSCORED)).not.toThrow();
  });

  test("accepts a real score with explaining reasons (plan §18)", () => {
    const parsed = ConfidenceScoreSchema.parse({
      value: 0.82,
      reasons: ["same public email", "two independent sources"],
    });
    expect(parsed.value).toBe(0.82);
    expect(parsed.reasons).toHaveLength(2);
  });

  test("rejects a score outside 0-1", () => {
    expect(() => ConfidenceScoreSchema.parse({ value: 1.5, reasons: [] })).toThrow();
  });
});

describe("CollectorEntitySchema", () => {
  const base = {
    id: "entity-1",
    type: "domain" as const,
    value: "example.com",
    displayName: "example.com",
    source: "dns",
    confidence: UNSCORED,
    metadata: {},
  };

  test("accepts a well-formed entity", () => {
    expect(() => CollectorEntitySchema.parse(base)).not.toThrow();
  });

  test("rejects an unknown entity type rather than coercing it", () => {
    expect(() => CollectorEntitySchema.parse({ ...base, type: "spaceship" })).toThrow();
  });

  test("rejects an empty value", () => {
    expect(() => CollectorEntitySchema.parse({ ...base, value: "" })).toThrow();
  });
});

describe("CollectorRelationshipSchema", () => {
  test("accepts one of the plan §19 relationship types", () => {
    const rel = {
      sourceEntity: "entity-1",
      relationshipType: "OWNS_DOMAIN" as const,
      targetEntity: "entity-2",
      confidence: UNSCORED,
      source: "rdap",
    };
    expect(() => CollectorRelationshipSchema.parse(rel)).not.toThrow();
  });

  test("rejects a relationship type outside the graph vocabulary", () => {
    const rel = {
      sourceEntity: "entity-1",
      relationshipType: "IS_FRIENDS_WITH",
      targetEntity: "entity-2",
      confidence: UNSCORED,
      source: "rdap",
    };
    expect(() => CollectorRelationshipSchema.parse(rel)).toThrow();
  });
});

describe("CollectorEvidenceSchema", () => {
  const base = {
    source: "crt.sh",
    sourceUrl: "https://crt.sh/?q=example.com",
    collector: "crtsh",
    collectedAt: "2026-08-14T00:00:00.000Z",
    rawValue: { raw: true },
    normalizedValue: { normalized: true },
    confidence: null,
    metadata: {},
  };

  test("accepts evidence with every Rule 6 field present", () => {
    expect(() => CollectorEvidenceSchema.parse(base)).not.toThrow();
  });

  test("sourceUrl may be null ('where applicable') but not absent", () => {
    expect(() => CollectorEvidenceSchema.parse({ ...base, sourceUrl: null })).not.toThrow();
    const { sourceUrl, ...withoutUrl } = base;
    expect(() => CollectorEvidenceSchema.parse(withoutUrl)).toThrow();
  });

  test("rejects evidence missing collectedAt — Rule 6 requires collection time on every fact", () => {
    const { collectedAt, ...withoutTime } = base;
    expect(() => CollectorEvidenceSchema.parse(withoutTime)).toThrow();
  });
});

describe("CollectorExecutionMetaSchema", () => {
  test("accepts a completed run with no error", () => {
    expect(() => CollectorExecutionMetaSchema.parse(COMPLETED_EXECUTION)).not.toThrow();
  });

  test("accepts a failed run carrying a typed error, not just an empty result (Rule 5)", () => {
    const failed = {
      status: "failed" as const,
      startedAt: "2026-08-14T00:00:00.000Z",
      completedAt: "2026-08-14T00:00:05.000Z",
      durationMs: 5000,
      resultCount: 0,
      error: {
        collector: "spiderfoot",
        reason: "timeout",
        message: "spiderfoot timed out after 5000ms",
      },
    };
    const parsed = CollectorExecutionMetaSchema.parse(failed);
    expect(parsed.error?.reason).toBe("timeout");
  });

  test("rejects an unknown status rather than defaulting", () => {
    expect(() =>
      CollectorExecutionMetaSchema.parse({ ...COMPLETED_EXECUTION, status: "done" }),
    ).toThrow();
  });
});

describe("InvestigationResultSchema / parseInvestigationResult", () => {
  test("emptyInvestigationResult produces a schema-valid result", () => {
    const result = emptyInvestigationResult(COMPLETED_EXECUTION);
    expect(() => InvestigationResultSchema.parse(result)).not.toThrow();
    expect(result.entities).toEqual([]);
  });

  test("parseInvestigationResult returns the parsed value on success", () => {
    const result = parseInvestigationResult(
      "test-collector",
      emptyInvestigationResult(COMPLETED_EXECUTION),
    );
    expect(result.execution.status).toBe("completed");
  });

  test("parseInvestigationResult throws InvestigationResultValidationError naming the collector on a bad shape", () => {
    expect(() => parseInvestigationResult("theharvester", { entities: "not-an-array" })).toThrow(
      InvestigationResultValidationError,
    );
    try {
      parseInvestigationResult("theharvester", { entities: "not-an-array" });
    } catch (err) {
      expect(err).toBeInstanceOf(InvestigationResultValidationError);
      expect((err as InvestigationResultValidationError).collectorId).toBe("theharvester");
    }
  });
});
