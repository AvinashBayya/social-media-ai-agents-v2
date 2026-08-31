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

/** A stub that answers every one of the six checks with a realistic "found nothing" shape. */
function emptyHandler(url: string): Response {
  if (url.includes("cloudflare-dns.com")) return mxResponse(false);
  if (url.includes("api.gravatar.com/v3/profiles/")) return new Response(null, { status: 404 });
  if (url.includes("www.gravatar.com/avatar/")) return new Response(null, { status: 404 });
  if (url.includes("api.github.com/search/commits")) {
    return new Response(JSON.stringify({ total_count: 0, items: [] }), { status: 200 });
  }
  if (url.includes("keys.openpgp.org/vks/v1/by-email/")) return new Response(null, { status: 404 });
  throw new Error(`unexpected fetch: ${url}`);
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
      if (url.includes("www.gravatar.com/avatar/")) return new Response("fake-image-bytes", { status: 200 });
      return emptyHandler(url);
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
      return emptyHandler(url);
    });
    const outcome = await contactEmailCollector.execute({ type: "email", value: "nobody@example.com" });
    expect(outcome.raw?.hasMx).toBe(false);
    expect(outcome.raw?.hasGravatar).toBe(false);
    expect(outcome.raw?.gravatarProfile).toEqual({
      exists: false,
      displayName: null,
      location: null,
      bio: null,
      jobTitle: null,
      company: null,
      verifiedAccounts: [],
    });
    expect(outcome.raw?.githubCommits).toEqual({ totalCount: 0, login: null });
    expect(outcome.raw?.openPgp).toEqual({ hasKey: false });
  });

  test("a syntactically invalid email skips every network lookup entirely and stays null, not false", async () => {
    const outcome = await contactEmailCollector.execute({ type: "email", value: "not-an-email" });
    expect(outcome.raw?.syntaxValid).toBe(false);
    expect(outcome.raw?.hasMx).toBeNull();
    expect(outcome.raw?.hasGravatar).toBeNull();
    expect(outcome.raw?.gravatarProfile).toBeNull();
    expect(outcome.raw?.gravatarHash256).toBeNull();
    expect(outcome.raw?.githubCommits).toBeNull();
    expect(outcome.raw?.openPgp).toBeNull();
  });

  test("a failed MX lookup reports null (inconclusive), never false (measured absence)", async () => {
    stubFetch((url) => {
      if (url.includes("cloudflare-dns.com")) throw new Error("network down");
      return emptyHandler(url);
    });
    const outcome = await contactEmailCollector.execute({ type: "email", value: "john@example.com" });
    expect(outcome.raw?.hasMx).toBeNull();
  });

  test("a real Gravatar profile returns owner-published fields and verified accounts", async () => {
    stubFetch((url) => {
      if (url.includes("api.gravatar.com/v3/profiles/")) {
        return new Response(
          JSON.stringify({
            display_name: "Jane Analyst",
            location: "Bengaluru, India",
            description: "OSINT researcher.",
            job_title: "Investigator",
            company: "Sentinel",
            verified_accounts: [
              { service_type: "github", service_label: "GitHub", url: "https://github.com/janeanalyst" },
              // An entry with no url is dropped, not fabricated as a link.
              { service_type: "unlisted", service_label: "Unlisted" },
            ],
          }),
          { status: 200 },
        );
      }
      return emptyHandler(url);
    });
    const outcome = await contactEmailCollector.execute({ type: "email", value: "jane@example.com" });
    expect(outcome.raw?.gravatarProfile?.exists).toBe(true);
    expect(outcome.raw?.gravatarProfile?.displayName).toBe("Jane Analyst");
    expect(outcome.raw?.gravatarProfile?.verifiedAccounts).toHaveLength(1);
    expect(outcome.raw?.gravatarProfile?.verifiedAccounts[0]).toEqual({
      serviceType: "github",
      serviceLabel: "GitHub",
      url: "https://github.com/janeanalyst",
    });
  });

  test("a Gravatar profile lookup that fails (not 404) is inconclusive, never a false negative", async () => {
    stubFetch((url) => {
      if (url.includes("api.gravatar.com/v3/profiles/")) return new Response(null, { status: 429 });
      return emptyHandler(url);
    });
    const outcome = await contactEmailCollector.execute({ type: "email", value: "john@example.com" });
    expect(outcome.raw?.gravatarProfile).toBeNull();
  });

  test("GitHub commit search resolving a login is reported distinctly from resolving none", async () => {
    stubFetch((url) => {
      if (url.includes("api.github.com/search/commits")) {
        return new Response(
          JSON.stringify({ total_count: 3, items: [{ author: { login: "torvalds" } }] }),
          { status: 200 },
        );
      }
      return emptyHandler(url);
    });
    const outcome = await contactEmailCollector.execute({ type: "email", value: "linus@example.com" });
    expect(outcome.raw?.githubCommits).toEqual({ totalCount: 3, login: "torvalds" });
  });

  test("GitHub commits found but with no resolvable author login stays login: null, not fabricated", async () => {
    stubFetch((url) => {
      if (url.includes("api.github.com/search/commits")) {
        return new Response(JSON.stringify({ total_count: 2, items: [{ author: null }] }), { status: 200 });
      }
      return emptyHandler(url);
    });
    const outcome = await contactEmailCollector.execute({ type: "email", value: "someone@example.com" });
    expect(outcome.raw?.githubCommits).toEqual({ totalCount: 2, login: null });
  });

  test("a GitHub rate limit (403) is inconclusive, never a measured zero commits", async () => {
    stubFetch((url) => {
      if (url.includes("api.github.com/search/commits")) return new Response(null, { status: 403 });
      return emptyHandler(url);
    });
    const outcome = await contactEmailCollector.execute({ type: "email", value: "john@example.com" });
    expect(outcome.raw?.githubCommits).toBeNull();
  });

  test("a real PGP key on keys.openpgp.org is a real positive", async () => {
    stubFetch((url) => {
      if (url.includes("keys.openpgp.org/vks/v1/by-email/")) {
        return new Response("-----BEGIN PGP PUBLIC KEY BLOCK-----\n...", { status: 200 });
      }
      return emptyHandler(url);
    });
    const outcome = await contactEmailCollector.execute({ type: "email", value: "dev@example.com" });
    expect(outcome.raw?.openPgp).toEqual({ hasKey: true });
  });
});

describe("contactEmailCollector.normalize", () => {
  test("produces one email entity and one evidence item per check that ran, when nothing else is found", async () => {
    stubFetch((url) => {
      if (url.includes("cloudflare-dns.com")) return mxResponse(true);
      if (url.includes("www.gravatar.com/avatar/")) return new Response("img", { status: 200 });
      return emptyHandler(url);
    });
    const outcome = await contactEmailCollector.execute({ type: "email", value: "john@example.com" });
    const result = contactEmailCollector.normalize(outcome);
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0].type).toBe("email");
    // syntax + MX + Gravatar avatar + Gravatar profile + GitHub commits + OpenPGP = 6.
    expect(result.evidence).toHaveLength(6);
    expect(result.relationships).toHaveLength(0);
  });

  test("invalid syntax produces only the syntax evidence item, plus a warning", async () => {
    const outcome = await contactEmailCollector.execute({ type: "email", value: "garbage" });
    const result = contactEmailCollector.normalize(outcome);
    expect(result.evidence).toHaveLength(1);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  test("a Gravatar-verified account becomes its own entity, linked with USES_USERNAME", async () => {
    stubFetch((url) => {
      if (url.includes("api.gravatar.com/v3/profiles/")) {
        return new Response(
          JSON.stringify({
            display_name: "Jane Analyst",
            verified_accounts: [{ service_type: "mastodon", service_label: "Mastodon", url: "https://mastodon.social/@jane" }],
          }),
          { status: 200 },
        );
      }
      return emptyHandler(url);
    });
    const outcome = await contactEmailCollector.execute({ type: "email", value: "jane@example.com" });
    const result = contactEmailCollector.normalize(outcome);
    const account = result.entities.find((e) => e.type === "social_account");
    expect(account?.value).toBe("https://mastodon.social/@jane");
    const rel = result.relationships.find((r) => r.relationshipType === "USES_USERNAME");
    expect(rel?.targetEntity).toBe(account?.id);
    // Ownership is asserted by Gravatar's own verification, not invented as a score.
    expect(rel?.confidence.value).toBeNull();
  });

  test("a GitHub commit match becomes a social_account entity, linked with CANDIDATE_ACCOUNT — never USES_USERNAME", async () => {
    stubFetch((url) => {
      if (url.includes("api.github.com/search/commits")) {
        return new Response(
          JSON.stringify({ total_count: 5, items: [{ author: { login: "torvalds" } }] }),
          { status: 200 },
        );
      }
      return emptyHandler(url);
    });
    const outcome = await contactEmailCollector.execute({ type: "email", value: "linus@example.com" });
    const result = contactEmailCollector.normalize(outcome);
    const account = result.entities.find((e) => e.type === "social_account");
    expect(account?.value).toBe("https://github.com/torvalds");
    const rel = result.relationships.find((r) => r.targetEntity === account?.id);
    // A self-declared, spoofable commit-author email must not read as a
    // confirmed identity match the way a Gravatar-verified link does.
    expect(rel?.relationshipType).toBe("CANDIDATE_ACCOUNT");
  });

  test("GitHub commits found with no resolvable login produce evidence but no entity or relationship", async () => {
    stubFetch((url) => {
      if (url.includes("api.github.com/search/commits")) {
        return new Response(JSON.stringify({ total_count: 4, items: [{ author: null }] }), { status: 200 });
      }
      return emptyHandler(url);
    });
    const outcome = await contactEmailCollector.execute({ type: "email", value: "someone@example.com" });
    const result = contactEmailCollector.normalize(outcome);
    expect(result.entities).toHaveLength(1); // the email entity only
    expect(result.relationships).toHaveLength(0);
    expect(result.evidence.some((e) => e.source.includes("GitHub commit search"))).toBe(true);
  });

  test("a failed lookup produces neither evidence nor an entity, and is named in the warnings", async () => {
    stubFetch((url) => {
      if (url.includes("api.gravatar.com/v3/profiles/")) return new Response(null, { status: 500 });
      if (url.includes("api.github.com/search/commits")) return new Response(null, { status: 403 });
      if (url.includes("keys.openpgp.org/vks/v1/by-email/")) return new Response(null, { status: 500 });
      return emptyHandler(url);
    });
    const outcome = await contactEmailCollector.execute({ type: "email", value: "john@example.com" });
    const result = contactEmailCollector.normalize(outcome);
    // syntax + MX + Gravatar avatar only — the three failed lookups add nothing.
    expect(result.evidence).toHaveLength(3);
    expect(result.warnings.some((w) => w.includes("Gravatar profile"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("GitHub commit-author"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("openpgp.org"))).toBe(true);
  });
});
