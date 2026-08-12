import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  CREDENTIAL_PROVIDERS,
  CredentialVaultError,
  STATUS_LABELS,
  VAULT_BACKUP_PATH,
  buildCapabilityMatrix,
  githubHeaders,
  maskSecret,
  normaliseEntry,
  normaliseHost,
  normaliseStatus,
  normaliseVault,
  providerById,
  redactEntry,
  redactVault,
  resolveCredential,
  secretTail,
  verifyProviderCredential,
  type CredentialEntry,
} from "../src/utils/credential-vault";

/**
 * The credentials vault.
 *
 * Two failures are under test here, and both actually shipped.
 *
 * The first is the fabricated status. The old form handler wrote
 * `status: "Active"` to disk the moment an operator pressed Save, for a secret
 * nothing had ever called. The page then rendered a green badge asserting that
 * an untested key worked. Every assertion below about `unverified` exists to
 * keep that from coming back: saving is not testing, and only a live call may
 * produce "Verified".
 *
 * The second is the disconnected store. The vault was written and never read,
 * so an operator could configure Reddit and collect nothing. The registry
 * invariants pin the contract that makes the connection auditable — every
 * provider names what it unlocks and which code path consumes it.
 */

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubFetch(handler: (url: string, init?: any) => Response) {
  globalThis.fetch = (async (input: any, init?: any) =>
    handler(String(input), init)) as typeof fetch;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

// ─── Registry invariants ───────────────────────────────────────────────────

describe("provider registry", () => {
  test("every provider states what it unlocks and what reads it", () => {
    // A vault entry that quietly feeds nothing is the exact failure this module
    // was written to remove, so it must not be disguised by an empty string.
    for (const p of CREDENTIAL_PROVIDERS) {
      expect(p.id.trim().length).toBeGreaterThan(0);
      expect(p.label.trim().length).toBeGreaterThan(0);
      expect(p.unlocks.trim().length).toBeGreaterThan(20);
      expect(p.consumedBy.trim().length).toBeGreaterThan(10);
      expect(p.secretLabel.trim().length).toBeGreaterThan(0);
    }
  });

  test("provider ids are unique", () => {
    const ids = CREDENTIAL_PROVIDERS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("a collectable provider names the env var that overrides the vault", () => {
    for (const p of CREDENTIAL_PROVIDERS.filter((x) => x.collectable)) {
      expect(p.envSecret?.trim().length ?? 0).toBeGreaterThan(0);
    }
  });

  test("a non-collectable provider explains itself and is never verifiable", () => {
    const blocked = CREDENTIAL_PROVIDERS.filter((p) => !p.collectable);
    expect(blocked.length).toBeGreaterThan(0);
    for (const p of blocked) {
      expect(p.blockedReason?.trim().length ?? 0).toBeGreaterThan(30);
      // Verification would have to return *something*, and the only honest
      // answer is "cannot be used" — so no probe is offered at all.
      expect(p.verifiable).toBe(false);
      expect(p.consumedBy).toMatch(/[Nn]othing reads this/);
    }
  });

  test("Meta platforms stay declared uncollectable", () => {
    // v1 wired these exact rows to a scraper that logged into Instagram and,
    // when that failed, invented posts. Both must stay non-collectable.
    expect(providerById("instagram")!.collectable).toBe(false);
    expect(providerById("facebook")!.collectable).toBe(false);
    expect(providerById("facebook")!.blockedReason).toMatch(/CrowdTangle/);
  });

  test("providerById returns null rather than guessing", () => {
    expect(providerById("twitter")).toBeNull();
    expect(providerById("reddit")?.envIdentifier).toBe("REDDIT_CLIENT_ID");
  });
});

// ─── Status is measured, never asserted ────────────────────────────────────

describe("normaliseStatus", () => {
  test('legacy "Active" is downgraded to unverified, not honoured', () => {
    // "Active" was written at save time for a secret nothing had tried. Reading
    // it back as verified would relaunch the fabricated green badge.
    expect(normaliseStatus("Active")).toBe("unverified");
    expect(normaliseStatus("Inactive")).toBe("unverified");
    expect(normaliseStatus(undefined)).toBe("unverified");
    expect(normaliseStatus(42)).toBe("unverified");
  });

  test("real measured states survive a round trip", () => {
    expect(normaliseStatus("verified")).toBe("verified");
    expect(normaliseStatus("REJECTED")).toBe("rejected");
    expect(normaliseStatus("unusable")).toBe("unusable");
  });

  test("every status has a display label", () => {
    for (const s of ["unverified", "verified", "rejected", "unusable"] as const) {
      expect(STATUS_LABELS[s].length).toBeGreaterThan(0);
    }
  });
});

// ─── Entry normalisation ───────────────────────────────────────────────────

describe("normaliseEntry", () => {
  test('the "Never" sentinel becomes null, not a timestamp', () => {
    // "Never" is a display string that was stored as data, which made "never
    // used" and "used at an unknown time" the same row.
    const e = normaliseEntry({ id: "a", secret: "s", lastUsed: "Never" }, "reddit", 0);
    expect(e.lastUsed).toBeNull();
    expect(e.verifiedAt).toBeNull();
    expect(e.verifyDetail).toBeNull();
  });

  test("a legacy row keeps its operator-entered data", () => {
    const e = normaliseEntry(
      {
        id: "instagram-1784806028918",
        label: "INSTAGRAM Token",
        username: "akhil_agent_ai",
        secret: "Akhil@agent",
        status: "Active",
      },
      "instagram",
      0,
    );
    expect(e.username).toBe("akhil_agent_ai");
    expect(e.secret).toBe("Akhil@agent");
    expect(e.label).toBe("INSTAGRAM Token");
  });

  test("a blocked provider is forced to unusable whatever the file says", () => {
    const e = normaliseEntry({ id: "x", secret: "s", status: "verified" }, "instagram", 0);
    expect(e.status).toBe("unusable");
  });

  test("a garbage timestamp is null rather than a parsed guess", () => {
    const e = normaliseEntry({ id: "x", secret: "s", verifiedAt: "yesterday" }, "reddit", 0);
    expect(e.verifiedAt).toBeNull();
  });

  test("a missing id falls back to an index-derived one rather than colliding", () => {
    const v = normaliseVault({ reddit: [{ secret: "a" }, { secret: "b" }] });
    expect(v.reddit[0].id).not.toBe(v.reddit[1].id);
  });
});

describe("normaliseVault", () => {
  test("non-object and non-array values are dropped, not coerced", () => {
    expect(normaliseVault(null)).toEqual({});
    expect(normaliseVault("nope")).toEqual({});
    expect(normaliseVault({ reddit: "nope" })).toEqual({});
  });

  test("the v1 file shape round-trips", () => {
    const v = normaliseVault({
      instagram: [{ id: "i1", username: "u", secret: "s", status: "Active" }],
      facebook: [],
      github: [],
    });
    expect(v.instagram).toHaveLength(1);
    expect(v.instagram[0].provider).toBe("instagram");
    expect(v.facebook).toEqual([]);
  });
});

// ─── Redaction: no secret crosses to the browser by accident ───────────────

describe("redaction", () => {
  const entry: CredentialEntry = {
    id: "reddit-1",
    provider: "reddit",
    label: "Primary",
    username: "client-id",
    secret: "super-secret-value",
    status: "verified",
    lastUsed: null,
    verifiedAt: null,
    verifyDetail: null,
    createdAt: null,
  };

  test("the redacted entry has no secret field at all", () => {
    const r = redactEntry(entry);
    expect("secret" in r).toBe(false);
    expect(JSON.stringify(r)).not.toContain("super-secret-value");
  });

  test("the mask is fixed width, so it does not leak the key length", () => {
    expect(maskSecret("ab")).toBe(maskSecret("a".repeat(200)));
  });

  test("an absent secret masks to nothing rather than to dots", () => {
    // Dots against an empty secret would show a credential that is not there.
    expect(maskSecret("")).toBe("");
  });

  test("the tail distinguishes two keys without revealing either", () => {
    expect(secretTail("abcdefgh")).toBe("efgh");
    expect(secretTail("abc")).toBe("");
  });

  test("redactVault covers every provider group", () => {
    const out = redactVault({ reddit: [entry], github: [] });
    expect(out.reddit[0].secretMask.length).toBeGreaterThan(0);
    expect(JSON.stringify(out)).not.toContain("super-secret-value");
  });
});

// ─── Backup path ───────────────────────────────────────────────────────────

describe("VAULT_BACKUP_PATH", () => {
  test("is a distinct file inside data/, so the ignore rules already cover it", () => {
    // Every write replaces the whole file, so a stale client can drop entries it
    // never knew about. The backup is the recovery path. It holds the same
    // cleartext secrets, so it must live under data/ — which .dockerignore
    // excludes wholesale and .gitignore names explicitly.
    expect(VAULT_BACKUP_PATH).toMatch(/^\.\/data\//);
    expect(VAULT_BACKUP_PATH).not.toBe("./data/credentials.json");
  });
});

// ─── Host normalisation ────────────────────────────────────────────────────

describe("normaliseHost", () => {
  test("reduces every written form to the bare host", () => {
    for (const input of [
      "mastodon.social",
      "https://mastodon.social",
      "https://mastodon.social/",
      "@mastodon.social",
      "  MASTODON.SOCIAL  ",
      "https://mastodon.social/@someone",
    ]) {
      expect(normaliseHost(input)).toBe("mastodon.social");
    }
  });
});

// ─── Resolution order ──────────────────────────────────────────────────────

describe("resolveCredential", () => {
  const KEY = "UCDP_API_TOKEN";
  const original = process.env[KEY];

  beforeEach(() => {
    delete process.env[KEY];
  });

  afterEach(() => {
    if (original === undefined) delete process.env[KEY];
    else process.env[KEY] = original;
  });

  test("the environment answers first and says so", async () => {
    // Key Vault secretrefs arrive as env vars through the container app's
    // managed identity. A file on an ephemeral replica must not shadow them.
    process.env[KEY] = "env-token";
    const r = await resolveCredential("ucdp");
    expect(r).not.toBeNull();
    expect(r!.secret).toBe("env-token");
    expect(r!.source).toBe("env");
    expect(r!.entryId).toBeNull();
  });

  test("whitespace-only env values are treated as absent", async () => {
    process.env[KEY] = "   ";
    expect(await resolveCredential("ucdp")).toBeNull();
  });

  test("an unknown provider resolves to null rather than throwing", async () => {
    expect(await resolveCredential("twitter")).toBeNull();
  });

  test("a non-collectable provider never resolves to a usable credential", async () => {
    // Nothing should be calling this for Instagram, but if something does it
    // must not receive something that looks usable.
    expect(await resolveCredential("instagram")).toBeNull();
    expect(await resolveCredential("facebook")).toBeNull();
  });
});

// ─── Live verification ─────────────────────────────────────────────────────

describe("verifyProviderCredential", () => {
  test("Reddit: a token response verifies and reports the TTL", async () => {
    stubFetch(() => json({ access_token: "tok", expires_in: 3600 }));
    const r = await verifyProviderCredential("reddit", "id", "secret");
    expect(r.status).toBe("verified");
    expect(r.detail).toMatch(/3600s/);
    expect(r.checkedAt).not.toBeNull();
  });

  test("Reddit: 200 with no access_token is a rejection, not a pass", async () => {
    stubFetch(() => json({}));
    const r = await verifyProviderCredential("reddit", "id", "secret");
    expect(r.status).toBe("rejected");
  });

  test("Reddit: 401 names the script-app requirement", async () => {
    stubFetch(() => json({ error: "unauthorized" }, 401));
    const r = await verifyProviderCredential("reddit", "id", "bad");
    expect(r.status).toBe("rejected");
    expect(r.detail).toMatch(/script/);
  });

  test("Bluesky: a session verifies and reports the resolved handle", async () => {
    stubFetch(() => json({ accessJwt: "jwt", did: "did:plc:x", handle: "a.bsky.social" }));
    const r = await verifyProviderCredential("bluesky", "a.bsky.social", "app-pw");
    expect(r.status).toBe("verified");
    expect(r.detail).toMatch(/a\.bsky\.social/);
  });

  test("Bluesky: 401 points at App Passwords rather than the account password", async () => {
    stubFetch(() => json({ error: "AuthenticationRequired", message: "Invalid" }, 401));
    const r = await verifyProviderCredential("bluesky", "a.bsky.social", "wrong");
    expect(r.status).toBe("rejected");
    expect(r.detail).toMatch(/App Password/i);
  });

  test("Bluesky: a 2FA challenge is reported as its own cause", async () => {
    stubFetch(() => json({ error: "AuthFactorTokenRequired" }, 400));
    const r = await verifyProviderCredential("bluesky", "a.bsky.social", "pw");
    expect(r.detail).toMatch(/two-factor/i);
  });

  test("Mastodon: the token is checked against the instance that issued it", async () => {
    let seen = "";
    stubFetch((url) => {
      seen = url;
      return json({ username: "analyst" });
    });
    const r = await verifyProviderCredential("mastodon", "https://mstdn.social/", "tok");
    expect(seen).toBe("https://mstdn.social/api/v1/accounts/verify_credentials");
    expect(r.status).toBe("verified");
  });

  test("a network failure is unverified, never rejected", async () => {
    // "We could not reach the provider" and "the provider refused you" call for
    // different operator actions; collapsing them would send someone off to
    // regenerate a key that was fine.
    globalThis.fetch = (async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    }) as typeof fetch;
    const r = await verifyProviderCredential("reddit", "id", "secret");
    expect(r.status).toBe("unverified");
    expect(r.detail).toMatch(/not tested/);
  });

  test("an empty secret is rejected without making a call", async () => {
    let called = false;
    stubFetch(() => {
      called = true;
      return json({});
    });
    const r = await verifyProviderCredential("reddit", "id", "   ");
    expect(r.status).toBe("rejected");
    expect(called).toBe(false);
  });

  test("a blocked provider can never be verified, whatever is pasted in", async () => {
    let called = false;
    stubFetch(() => {
      called = true;
      return json({ ok: true });
    });
    for (const id of ["instagram", "facebook"]) {
      const r = await verifyProviderCredential(id, "user", "password");
      expect(r.status).toBe("unusable");
      // checkedAt stays null because no call was made; a timestamp would imply
      // something had been tested.
      expect(r.checkedAt).toBeNull();
    }
    expect(called).toBe(false);
  });

  test("an unknown provider throws rather than silently passing", async () => {
    await expect(verifyProviderCredential("twitter", "a", "b")).rejects.toBeInstanceOf(
      CredentialVaultError,
    );
  });
});

// ─── Capability matrix ─────────────────────────────────────────────────────

describe("buildCapabilityMatrix", () => {
  test("reports one row per provider and leaks no secret", async () => {
    const rows = await buildCapabilityMatrix();
    expect(rows).toHaveLength(CREDENTIAL_PROVIDERS.length);
    for (const row of rows) {
      expect(typeof row.configured).toBe("boolean");
      expect(Object.keys(row)).not.toContain("secret");
    }
  });

  test("a non-collectable provider is never reported as configured", async () => {
    const rows = await buildCapabilityMatrix();
    for (const row of rows.filter((r) => !r.collectable)) {
      expect(row.configured).toBe(false);
      expect(row.source).toBeNull();
    }
  });
});

// ─── Consumer helper ───────────────────────────────────────────────────────

describe("githubHeaders", () => {
  const KEY = "GITHUB_TOKEN";
  const original = process.env[KEY];

  afterEach(() => {
    if (original === undefined) delete process.env[KEY];
    else process.env[KEY] = original;
  });

  test("adds a bearer token when one is configured", async () => {
    process.env[KEY] = "ghp_test";
    const h = await githubHeaders();
    expect(h.authorization).toBe("Bearer ghp_test");
  });

  test("stays usable unauthenticated — the token raises a ceiling, it is not a gate", async () => {
    delete process.env[KEY];
    const h = await githubHeaders();
    expect(h.authorization).toBeUndefined();
    expect(h["user-agent"]).toMatch(/SentinelAI/);
  });
});
