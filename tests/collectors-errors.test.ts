import { describe, expect, test } from "bun:test";
import {
  CollectorError,
  collectorNoCredential,
  collectorTimeout,
  collectorUnavailable,
} from "../src/utils/collectors/errors";

describe("CollectorError", () => {
  test("carries collectorId and reason as first-class fields, not just in the message", () => {
    const err = new CollectorError("spiderfoot", "timeout", "spiderfoot timed out after 30000ms");
    expect(err.collectorId).toBe("spiderfoot");
    expect(err.reason).toBe("timeout");
    expect(err.name).toBe("CollectorError");
  });

  test("toInfo() produces the plain-data shape for Rule 5's status/reason report", () => {
    const err = new CollectorError("spiderfoot", "timeout", "spiderfoot timed out after 30000ms");
    expect(err.toInfo()).toEqual({
      collector: "spiderfoot",
      reason: "timeout",
      message: "spiderfoot timed out after 30000ms",
    });
  });

  test("is a real Error instance so it can be thrown/caught normally", () => {
    expect(() => {
      throw new CollectorError("dns", "unavailable", "dns is unavailable");
    }).toThrow(CollectorError);
  });
});

describe("factory helpers", () => {
  test("collectorTimeout produces a timeout-reasoned error naming the collector and budget", () => {
    const err = collectorTimeout("theharvester", 15000);
    expect(err.reason).toBe("timeout");
    expect(err.collectorId).toBe("theharvester");
    expect(err.message).toContain("15000ms");
  });

  test("collectorUnavailable produces an unavailable-reasoned error", () => {
    const err = collectorUnavailable("spiderfoot", "worker process not running");
    expect(err.reason).toBe("unavailable");
    expect(err.message).toContain("worker process not running");
  });

  test("collectorNoCredential produces a no-credential-reasoned error", () => {
    const err = collectorNoCredential("shodan", "SHODAN_API_KEY not set");
    expect(err.reason).toBe("no-credential");
    expect(err.message).toContain("SHODAN_API_KEY");
  });
});
