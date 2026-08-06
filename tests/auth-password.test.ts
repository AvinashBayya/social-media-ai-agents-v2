import { describe, expect, test } from "bun:test";

import {
  DEFAULT_ARGON2_PARAMS,
  hashPassword,
  needsRehash,
  parsePhc,
  spendDummyVerification,
  verifyPassword,
} from "../src/server/auth/password";

/**
 * Argon2id hashing.
 *
 * Uses deliberately cheap parameters — the shipped cost (19 MiB, 2 passes) is
 * chosen to be slow, and hashing at that cost dozens of times would make this
 * file take minutes. The parameters under test are the plumbing, not the cost.
 */
const CHEAP = { memoryKib: 8192, iterations: 1, parallelism: 1 } as const;

describe("hashPassword", () => {
  test("produces a PHC-encoded argon2id string", async () => {
    const hash = await hashPassword("Correct!Horse9", CHEAP);

    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(hash).toContain("m=8192");
    expect(hash).toContain("t=1");
    expect(hash).toContain("p=1");
  });

  test("never stores the plaintext", async () => {
    const hash = await hashPassword("Correct!Horse9", CHEAP);
    expect(hash).not.toContain("Correct!Horse9");
  });

  test("salts, so the same password hashes differently every time", async () => {
    const [a, b] = await Promise.all([
      hashPassword("Correct!Horse9", CHEAP),
      hashPassword("Correct!Horse9", CHEAP),
    ]);

    expect(a).not.toBe(b);
    // Both must still verify — different salt, same password.
    expect(await verifyPassword("Correct!Horse9", a)).toBe(true);
    expect(await verifyPassword("Correct!Horse9", b)).toBe(true);
  });

  test("refuses an empty password", async () => {
    await expect(hashPassword("", CHEAP)).rejects.toThrow(/empty password/i);
  });
});

describe("verifyPassword", () => {
  test("accepts the correct password", async () => {
    const hash = await hashPassword("Tr0ub4dor&3", CHEAP);
    expect(await verifyPassword("Tr0ub4dor&3", hash)).toBe(true);
  });

  test("rejects the wrong password", async () => {
    const hash = await hashPassword("Tr0ub4dor&3", CHEAP);
    expect(await verifyPassword("tr0ub4dor&3", hash)).toBe(false);
    expect(await verifyPassword("Tr0ub4dor&4", hash)).toBe(false);
  });

  test("returns false rather than throwing on a corrupt hash", async () => {
    // A damaged row must fail the login quietly. Throwing would produce a 500
    // where every other account gives a 401, which is itself an oracle telling
    // an attacker this particular account exists.
    expect(await verifyPassword("anything", "not-a-phc-string")).toBe(false);
    expect(await verifyPassword("anything", "$argon2id$garbage")).toBe(false);
    expect(await verifyPassword("anything", "")).toBe(false);
  });

  test("rejects an empty candidate against a real hash", async () => {
    const hash = await hashPassword("Tr0ub4dor&3", CHEAP);
    expect(await verifyPassword("", hash)).toBe(false);
  });
});

describe("parsePhc", () => {
  test("reads the parameters back out of a hash", async () => {
    const hash = await hashPassword("Tr0ub4dor&3", CHEAP);
    const parsed = parsePhc(hash);

    expect(parsed).not.toBeNull();
    expect(parsed?.variant).toBe("argon2id");
    expect(parsed?.version).toBe(19);
    expect(parsed?.params).toEqual({ memoryKib: 8192, iterations: 1, parallelism: 1 });
  });

  test("returns null for anything unparseable", () => {
    expect(parsePhc("")).toBeNull();
    expect(parsePhc("$2b$10$abcdefghijklmnopqrstuv")).toBeNull();
  });
});

describe("needsRehash", () => {
  test("is false when the hash already meets the target cost", async () => {
    const hash = await hashPassword("Tr0ub4dor&3", CHEAP);
    expect(needsRehash(hash, CHEAP)).toBe(false);
  });

  test("is true when the configured cost has been raised", async () => {
    const hash = await hashPassword("Tr0ub4dor&3", CHEAP);
    expect(needsRehash(hash, { ...CHEAP, memoryKib: 19456 })).toBe(true);
    expect(needsRehash(hash, { ...CHEAP, iterations: 3 })).toBe(true);
  });

  test("is false when the stored cost exceeds the target", async () => {
    // Lowering the configured cost must not downgrade existing hashes.
    const hash = await hashPassword("Tr0ub4dor&3", { ...CHEAP, iterations: 3 });
    expect(needsRehash(hash, CHEAP)).toBe(false);
  });

  test("is true for a non-argon2id variant or an unreadable hash", () => {
    expect(needsRehash("$argon2i$v=19$m=8192,t=1,p=1$c2FsdA$aGFzaA", CHEAP)).toBe(true);
    expect(needsRehash("$2b$10$something", CHEAP)).toBe(true);
  });
});

describe("spendDummyVerification", () => {
  test("resolves without throwing and reveals nothing", async () => {
    // Its only job is to burn comparable CPU on the "no such user" branch so
    // response time does not distinguish a missing account from a wrong
    // password. It must never surface an error to the login path.
    await expect(spendDummyVerification("whatever", CHEAP)).resolves.toBeUndefined();
  });
});

describe("DEFAULT_ARGON2_PARAMS", () => {
  test("meets the OWASP baseline", () => {
    // Guards against someone quietly lowering the shipped cost.
    expect(DEFAULT_ARGON2_PARAMS.memoryKib).toBeGreaterThanOrEqual(19456);
    expect(DEFAULT_ARGON2_PARAMS.iterations).toBeGreaterThanOrEqual(2);
    expect(DEFAULT_ARGON2_PARAMS.parallelism).toBeGreaterThanOrEqual(1);
  });
});
