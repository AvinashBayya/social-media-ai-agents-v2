import { describe, expect, test } from "bun:test";
import { contactPhoneCollector } from "../src/utils/collectors/person/contact-phone";

describe("contactPhoneCollector.execute — offline, no lookup", () => {
  test("rejects an empty target", async () => {
    const outcome = await contactPhoneCollector.execute({ type: "phone", value: "" });
    expect(outcome.raw).toBeNull();
    expect(outcome.execution.error?.reason).toBe("invalid-target");
  });

  test("parses a real, valid E.164 number", async () => {
    const outcome = await contactPhoneCollector.execute({ type: "phone", value: "+919876543210" });
    expect(outcome.execution.status).toBe("completed");
    expect(outcome.raw?.valid).toBe(true);
    expect(outcome.raw?.country).toBe("IN");
    expect(outcome.raw?.e164).toBe("+919876543210");
  });

  test("a structurally invalid number still completes (with valid:false), not a collector failure", async () => {
    const outcome = await contactPhoneCollector.execute({ type: "phone", value: "12345" });
    expect(outcome.execution.status).toBe("completed");
    expect(outcome.raw?.valid).toBe(false);
  });

  test("garbage input that fails to parse at all still completes with a null country/e164", async () => {
    const outcome = await contactPhoneCollector.execute({ type: "phone", value: "not-a-phone-number" });
    expect(outcome.execution.status).toBe("completed");
    expect(outcome.raw?.country).toBeNull();
    expect(outcome.raw?.e164).toBeNull();
  });
});

describe("contactPhoneCollector.normalize", () => {
  test("produces exactly one phone entity, no relationships (no lookup to relate to anything)", async () => {
    const outcome = await contactPhoneCollector.execute({ type: "phone", value: "+919876543210" });
    const result = contactPhoneCollector.normalize(outcome);
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].type).toBe("phone");
    expect(result.relationships).toHaveLength(0);
  });

  test("confidence is null-valued — structural validity is not cross-source corroboration", async () => {
    const outcome = await contactPhoneCollector.execute({ type: "phone", value: "+919876543210" });
    const result = contactPhoneCollector.normalize(outcome);
    expect(result.entities[0].confidence.value).toBeNull();
  });

  test("an invalid number produces a warning naming it explicitly", async () => {
    const outcome = await contactPhoneCollector.execute({ type: "phone", value: "123" });
    const result = contactPhoneCollector.normalize(outcome);
    expect(result.warnings.some((w) => w.includes("123"))).toBe(true);
  });

  test("a failed execution normalizes to the shared empty-result shape (normalizeGuard)", async () => {
    const failed = await contactPhoneCollector.execute({ type: "phone", value: "" });
    const result = contactPhoneCollector.normalize(failed);
    expect(result.entities).toHaveLength(0);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe("contactPhoneCollector.healthCheck", () => {
  test("always reports ready — no external dependency", async () => {
    const health = await contactPhoneCollector.healthCheck();
    expect(health.state).toBe("ready");
  });
});
