import { afterEach, describe, expect, test } from "bun:test";
import { contactEmailCollector } from "../src/utils/collectors/person/contact-email";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubFetch(handler: (url: string) => Response | Promise<Response>) {
  globalThis.fetch = ((url: any) => handler(String(url))) as typeof fetch;
}

function mxResponse(hasMx: boolean, host = "mail.example.com") {
  return new Response(
    JSON.stringify({
      Status: 0,
      Answer: hasMx ? [{ type: 15, data: `10 ${host}.` }] : [],
    }),
    { headers: { "content-type": "application/dns-json" } },
  );
}

describe("contactEmailCollector.execute", () => {
  test("rejects an empty target", async () => {
    const outcome = await contactEmailCollector.execute({ type: "email", value: "" });
    expect(outcome.raw).toBeNull();
    expect(outcome.execution.error?.reason).toBe("invalid-target");
  });

  test("valid syntax + real MX + a real Gravatar avatar", async () => {
    stubFetch((url) => {
      if (url.includes("cloudflare-dns.com")) return mxResponse(true, "mail.example.com");
      if (url.includes("gravatar.com")) return new Response("fake-image-bytes", { status: 200 });
      throw new Error(`unexpected fetch: ${url}`);
    });
    const outcome = await contactEmailCollector.execute({ type: "email", value: "john@example.com" });
    expect(outcome.execution.status).toBe("completed");
    expect(outcome.raw?.syntaxValid).toBe(true);
    expect(outcome.raw?.hasMx).toBe(true);
    expect(outcome.raw?.mxHost).toBe("mail.example.com");
    expect(outcome.raw?.hasGravatar).toBe(true);
  });

  test("no MX records and no Gravatar are both real, measured negatives — not null", async () => {
    stubFetch((url) => {
      if (url.includes("cloudflare-dns.com")) return mxResponse(false);
      if (url.includes("gravatar.com")) return new Response(null, { status: 404 });
      throw new Error(`unexpected fetch: ${url}`);
    });
    const outcome = await contactEmailCollector.execute({ type: "email", value: "nobody@example.com" });
    expect(outcome.raw?.hasMx).toBe(false);
    expect(outcome.raw?.hasGravatar).toBe(false);
  });

  test("a syntactically invalid email skips MX/Gravatar lookups entirely and stays null, not false", async () => {
    const outcome = await contactEmailCollector.execute({ type: "email", value: "not-an-email" });
    expect(outcome.raw?.syntaxValid).toBe(false);
    expect(outcome.raw?.hasMx).toBeNull();
    expect(outcome.raw?.hasGravatar).toBeNull();
  });

  test("a failed MX lookup reports null (inconclusive), never false (measured absence)", async () => {
    stubFetch((url) => {
      if (url.includes("cloudflare-dns.com")) throw new Error("network down");
      return new Response(null, { status: 404 });
    });
    const outcome = await contactEmailCollector.execute({ type: "email", value: "john@example.com" });
    expect(outcome.raw?.hasMx).toBeNull();
  });
});

describe("contactEmailCollector.normalize", () => {
  test("produces one email entity and evidence for each check that actually ran", async () => {
    stubFetch((url) => {
      if (url.includes("cloudflare-dns.com")) return mxResponse(true);
      return new Response("img", { status: 200 });
    });
    const outcome = await contactEmailCollector.execute({ type: "email", value: "john@example.com" });
    const result = contactEmailCollector.normalize(outcome);
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].type).toBe("email");
    // syntax + MX + Gravatar = 3 evidence items when every check runs.
    expect(result.evidence).toHaveLength(3);
  });

  test("invalid syntax produces only the syntax evidence item, plus a warning", async () => {
    const outcome = await contactEmailCollector.execute({ type: "email", value: "garbage" });
    const result = contactEmailCollector.normalize(outcome);
    expect(result.evidence).toHaveLength(1);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
