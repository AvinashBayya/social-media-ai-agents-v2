import { describe, expect, it } from "bun:test";

import {
  AddCredentialInput,
  CredentialRefInput,
  VaultFileInput,
  redactVault,
  type CredentialEntry,
} from "../src/utils/credential-vault";

/**
 * Regression tests for the unauthenticated credential exposure closed on
 * 2026-08-17.
 *
 * `getCredentials` (routes/settings.tsx) was a GET server function with no
 * validator that returned `readVault()` VERBATIM — every stored secret, in
 * cleartext, to any caller who could reach the origin. The route gate is the
 * disclosed client-side demo session, and CSRF middleware does not stop a
 * direct request. These pin the properties that fix depends on.
 */

function entry(over: Partial<CredentialEntry> = {}): CredentialEntry {
  return {
    id: "bluesky-1",
    provider: "bluesky",
    label: "Bluesky app password",
    username: "analyst.bsky.social",
    secret: "abcd-efgh-ijkl-mnop",
    status: "verified",
    lastUsed: null,
    verifiedAt: null,
    verifyDetail: null,
    createdAt: null,
    ...over,
  };
}

describe("redaction is total", () => {
  const vault = { bluesky: [entry()], github: [entry({ provider: "github", secret: "ghp_secret" })] };

  it("no secret value survives redactVault", () => {
    const serialised = JSON.stringify(redactVault(vault));
    expect(serialised).not.toContain("abcd-efgh-ijkl-mnop");
    expect(serialised).not.toContain("ghp_secret");
  });

  it("drops the secret key entirely rather than blanking it", () => {
    const out = redactVault(vault).bluesky[0] as unknown as Record<string, unknown>;
    expect("secret" in out).toBe(false);
  });

  it("keeps the tail so an operator can still tell two keys apart", () => {
    expect(redactVault(vault).bluesky[0].secretTail).toBe("mnop");
  });

  it("mask width does not leak the secret's length", () => {
    const short = redactVault({ a: [entry({ secret: "xy" })] }).a[0].secretMask;
    const long = redactVault({ a: [entry({ secret: "x".repeat(200) })] }).a[0].secretMask;
    expect(short).toBe(long);
  });

  it("an absent secret renders as nothing, not as dots", () => {
    // Dots would show a credential that is not there as though one were stored.
    expect(redactVault({ a: [entry({ secret: "" })] }).a[0].secretMask).toBe("");
  });
});

describe("VaultFileInput — the whole-file write", () => {
  it("accepts a well-formed vault", () => {
    expect(VaultFileInput.safeParse({ bluesky: [{ id: "x", secret: "y" }] }).success).toBe(true);
  });

  it("rejects an unknown top-level provider key", () => {
    // `saveCredentials` validated with `(data: any) => data` and replaced the
    // WHOLE file, so any key at all landed in data/credentials.json.
    expect(VaultFileInput.safeParse({ "not-a-provider": [] }).success).toBe(false);
  });

  it("rejects prototype-polluting keys as they actually arrive", () => {
    // Written via JSON.parse on purpose: `{ __proto__: [] }` as an object
    // literal SETS the prototype and creates no own property, so it would test
    // nothing. A JSON body does create the own key — which is the shape that
    // reaches a server function over the wire.
    expect(VaultFileInput.safeParse(JSON.parse('{"__proto__": []}')).success).toBe(false);
    expect(VaultFileInput.safeParse(JSON.parse('{"constructor": []}')).success).toBe(false);
    expect(VaultFileInput.safeParse(JSON.parse('{"prototype": []}')).success).toBe(false);
  });

  it("rejects an oversized payload rather than writing it to disk", () => {
    const huge = { bluesky: [{ id: "x", secret: "s".repeat(200_000) }] };
    expect(VaultFileInput.safeParse(huge).success).toBe(false);
  });

  it("caps entries per provider", () => {
    const many = { bluesky: Array.from({ length: 200 }, (_, i) => ({ id: `e${i}` })) };
    expect(VaultFileInput.safeParse(many).success).toBe(false);
  });
});

describe("AddCredentialInput", () => {
  it("accepts a normal credential", () => {
    const ok = AddCredentialInput.safeParse({
      provider: "mastodon",
      label: "My instance token",
      username: "mastodon.social",
      secret: "token-value",
    });
    expect(ok.success).toBe(true);
  });

  it("rejects an unknown provider — an unlisted id is not a new provider", () => {
    expect(
      AddCredentialInput.safeParse({ provider: "evil", username: "x", secret: "y" }).success,
    ).toBe(false);
  });

  it("requires a non-empty secret", () => {
    expect(
      AddCredentialInput.safeParse({ provider: "github", username: "", secret: "" }).success,
    ).toBe(false);
  });

  it("bounds the secret and identifier", () => {
    expect(
      AddCredentialInput.safeParse({
        provider: "github",
        username: "",
        secret: "s".repeat(5000),
      }).success,
    ).toBe(false);
    expect(
      AddCredentialInput.safeParse({
        provider: "github",
        username: "u".repeat(300),
        secret: "s",
      }).success,
    ).toBe(false);
  });

  it("rejects an identifier carrying markup or whitespace", () => {
    // `username` doubles as the Mastodon INSTANCE HOST, which is the input half
    // of the token-forwarding chain.
    expect(
      AddCredentialInput.safeParse({
        provider: "mastodon",
        username: "<script>alert(1)</script>",
        secret: "s",
      }).success,
    ).toBe(false);
  });
});

describe("CredentialRefInput", () => {
  it("rejects a traversal-shaped id", () => {
    expect(
      CredentialRefInput.safeParse({ provider: "bluesky", id: "../../etc/passwd" }).success,
    ).toBe(false);
  });

  it("rejects an unknown provider", () => {
    expect(CredentialRefInput.safeParse({ provider: "nope", id: "x" }).success).toBe(false);
  });
});
