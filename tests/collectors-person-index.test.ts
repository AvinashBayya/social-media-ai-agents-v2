import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { CollectorRegistry } from "../src/utils/collectors/registry";
import { PERSON_COLLECTORS, registerPersonCollectors, resolvePersonCollectorId } from "../src/utils/collectors/person";

const ENV = "PERSON_INVESTIGATION_ENABLED";
const originalFlag = process.env[ENV];

beforeEach(() => {
  delete process.env[ENV];
});

afterEach(() => {
  if (originalFlag === undefined) delete process.env[ENV];
  else process.env[ENV] = originalFlag;
});

describe("registerPersonCollectors — feature-flag gated", () => {
  test("is a no-op when the flag is unset (default off)", () => {
    const registry = new CollectorRegistry();
    registerPersonCollectors(registry);
    expect(registry.list()).toHaveLength(0);
  });

  test("registers all 7 new collectors plus the reused news/rdap pair when enabled", () => {
    process.env[ENV] = "true";
    const registry = new CollectorRegistry();
    registerPersonCollectors(registry);
    for (const c of PERSON_COLLECTORS) {
      expect(registry.get(c.id)).toBeDefined();
    }
    expect(registry.get("news")).toBeDefined();
    expect(registry.get("rdap")).toBeDefined();
  });

  test("is idempotent — calling twice does not throw DuplicateCollectorError", () => {
    process.env[ENV] = "true";
    const registry = new CollectorRegistry();
    expect(() => {
      registerPersonCollectors(registry);
      registerPersonCollectors(registry);
    }).not.toThrow();
  });

  test("does not register a redundant presence.news collector — the id simply doesn't exist", () => {
    process.env[ENV] = "true";
    const registry = new CollectorRegistry();
    registerPersonCollectors(registry);
    expect(registry.get("presence.news")).toBeUndefined();
  });
});

describe("resolvePersonCollectorId", () => {
  test("presence.news resolves to the shared news collector's real id", () => {
    expect(resolvePersonCollectorId("presence.news")).toBe("news");
  });

  test("every other id resolves to itself", () => {
    expect(resolvePersonCollectorId("contact.email")).toBe("contact.email");
    expect(resolvePersonCollectorId("presence.image")).toBe("presence.image");
  });
});
