import { afterEach, describe, expect, test } from "bun:test";
import { contactDomainCollector } from "../src/utils/collectors/person/contact-domain";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubFetch(make: () => Response | Promise<Response>) {
  globalThis.fetch = (async () => make()) as typeof fetch;
}

describe("contactDomainCollector.execute", () => {
  test("rejects an empty target", async () => {
    const outcome = await contactDomainCollector.execute({ type: "domain", value: "" });
    expect(outcome.raw).toBeNull();
    expect(outcome.execution.error?.reason).toBe("invalid-target");
  });

  test("detects a real signature from response headers and HTML body", async () => {
    stubFetch(
      () =>
        new Response("<html><head></head><body><script src=\"/wp-content/theme.js\"></script></body></html>", {
          status: 200,
          headers: { server: "nginx" },
        }),
    );
    const outcome = await contactDomainCollector.execute({ type: "domain", value: "example.com" });
    expect(outcome.execution.status).toBe("completed");
    expect(outcome.raw?.reachable).toBe(true);
    expect(outcome.raw?.detected).toContain("WordPress");
    expect(outcome.raw?.detected).toContain("Nginx");
  });

  test("a reachable site matching none of the signatures still completes, with an empty detected list", async () => {
    stubFetch(() => new Response("<html><body>plain</body></html>", { status: 200 }));
    const outcome = await contactDomainCollector.execute({ type: "domain", value: "example.com" });
    expect(outcome.execution.status).toBe("completed");
    expect(outcome.raw?.detected).toEqual([]);
  });

  test("an unreachable domain completes with reachable:false, not a collector failure", async () => {
    stubFetch(() => {
      throw new Error("fetch failed: getaddrinfo ENOTFOUND");
    });
    const outcome = await contactDomainCollector.execute({ type: "domain", value: "nonexistent.invalid" });
    expect(outcome.execution.status).toBe("completed");
    expect(outcome.raw?.reachable).toBe(false);
  });
});

describe("contactDomainCollector.normalize", () => {
  test("produces one domain entity carrying the detected list and disclosure text", async () => {
    stubFetch(() => new Response("<html>__NEXT_DATA__</html>", { status: 200 }));
    const outcome = await contactDomainCollector.execute({ type: "domain", value: "example.com" });
    const result = contactDomainCollector.normalize(outcome);
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].metadata.detected).toContain("Next.js");
    expect(String(result.entities[0].metadata.disclosure)).toContain("self-hosted");
  });

  test("an unreachable domain produces a clear warning naming it", async () => {
    stubFetch(() => {
      throw new Error("timed out");
    });
    const outcome = await contactDomainCollector.execute({ type: "domain", value: "example.com" });
    const result = contactDomainCollector.normalize(outcome);
    expect(result.warnings.some((w) => w.includes("example.com"))).toBe(true);
  });
});
