import { describe, expect, test } from "bun:test";
import { presenceImageCollector } from "../src/utils/collectors/person/presence-image";

describe("presenceImageCollector — deliberately, permanently unavailable", () => {
  test("execute always fails with reason unavailable, regardless of target", async () => {
    const outcome = await presenceImageCollector.execute({ type: "person", value: "John Smith" });
    expect(outcome.raw).toBeNull();
    expect(outcome.execution.status).toBe("failed");
    expect(outcome.execution.error?.reason).toBe("unavailable");
  });

  test("the failure message explains why, citing the real NOT_IMPLEMENTED reasoning (DPDP Act 2023)", async () => {
    const outcome = await presenceImageCollector.execute({ type: "person", value: "John Smith" });
    expect(outcome.execution.error?.message).toContain("DPDP Act 2023");
  });

  test("normalize produces the shared empty-result shape carrying the error, never fabricated entities", () => {
    const outcome = { execution: { status: "failed" as const, startedAt: "2026-01-01T00:00:00.000Z", completedAt: "2026-01-01T00:00:00.000Z", durationMs: 0, resultCount: 0, error: { collector: "presence.image", reason: "unavailable" as const, message: "test" } }, raw: null };
    const result = presenceImageCollector.normalize(outcome);
    expect(result.entities).toHaveLength(0);
    expect(result.errors).toContain("test");
  });

  test("healthCheck reports unavailable, not ready", async () => {
    const health = await presenceImageCollector.healthCheck();
    expect(health.state).toBe("unavailable");
  });

  test("declares no credential requirement — no key would ever unlock this", () => {
    expect(presenceImageCollector.requiresCredentials).toBe(false);
  });
});
