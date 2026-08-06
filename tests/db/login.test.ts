import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { AUDIT_ACTIONS } from "@/server/auth/audit";
import { authenticate, changeOwnPassword, logout } from "@/server/auth/login";
import { hashPassword } from "@/server/auth/password";
import { createSession, resolveSession } from "@/server/auth/sessions";

import {
  createTestDatabase,
  TEST_ARGON2_PARAMS,
  TEST_LOGIN_CONFIG,
  type TestDatabase,
} from "./helpers/test-db";

/**
 * The login flow, end to end, against a real database.
 *
 * The order of the checks inside `authenticate` is the security-relevant part
 * and most of these tests exist to pin it down: throttle before hashing,
 * password before account status, new token only after everything passes.
 */

const PASSWORD = "Kestrel!42Vane";
const ORIGIN = { ipAddress: "10.0.0.5", userAgent: "test-agent" };

let db: TestDatabase;

async function seedUser(overrides: Record<string, unknown> = {}) {
  return db.prisma.user.create({
    data: {
      username: "analyst",
      email: "analyst@sentinel.local",
      passwordHash: await hashPassword(PASSWORD, TEST_ARGON2_PARAMS),
      role: "Employee",
      isActive: true,
      mustChangePassword: false,
      ...overrides,
    },
  });
}

const actions = async () =>
  (await db.prisma.auditLog.findMany({ orderBy: { createdAt: "asc" } })).map((a) => a.action);

beforeEach(async () => {
  db = await createTestDatabase();
});

afterEach(async () => {
  await db.close();
});

describe("authenticate — success", () => {
  test("accepts the correct password and returns a token", async () => {
    const user = await seedUser();

    const result = await authenticate(
      db.prisma,
      { identifier: "analyst", password: PASSWORD, remember: false },
      TEST_LOGIN_CONFIG,
      ORIGIN,
    );

    expect(result.user.id).toBe(user.id);
    expect(result.user.username).toBe("analyst");
    expect(result.token).toBeTruthy();
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  test("matches on email as well as username", async () => {
    await seedUser();

    const result = await authenticate(
      db.prisma,
      { identifier: "ANALYST@SENTINEL.LOCAL", password: PASSWORD, remember: false },
      TEST_LOGIN_CONFIG,
      ORIGIN,
    );

    expect(result.user.username).toBe("analyst");
  });

  test("is case- and whitespace-insensitive on the identifier", async () => {
    await seedUser();

    const result = await authenticate(
      db.prisma,
      { identifier: "  Analyst  ", password: PASSWORD, remember: false },
      TEST_LOGIN_CONFIG,
      ORIGIN,
    );

    expect(result.user.username).toBe("analyst");
  });

  test("records lastLoginAt and audits the success", async () => {
    await seedUser();

    await authenticate(
      db.prisma,
      { identifier: "analyst", password: PASSWORD, remember: false },
      TEST_LOGIN_CONFIG,
      ORIGIN,
    );

    const user = await db.prisma.user.findFirst();
    expect(user?.lastLoginAt).not.toBeNull();
    expect(await actions()).toContain(AUDIT_ACTIONS.LOGIN_SUCCESS);
  });

  test("'remember me' produces a longer-lived session", async () => {
    await seedUser();
    const now = new Date("2026-01-01T00:00:00Z");

    const short = await authenticate(
      db.prisma,
      { identifier: "analyst", password: PASSWORD, remember: false },
      TEST_LOGIN_CONFIG,
      ORIGIN,
      now,
    );
    const long = await authenticate(
      db.prisma,
      { identifier: "analyst", password: PASSWORD, remember: true },
      TEST_LOGIN_CONFIG,
      ORIGIN,
      now,
    );

    expect(long.expiresAt.getTime()).toBeGreaterThan(short.expiresAt.getTime());
  });

  test("clears earlier failures once the password is correct", async () => {
    await seedUser();

    for (let i = 0; i < 3; i += 1) {
      await expect(
        authenticate(
          db.prisma,
          { identifier: "analyst", password: "Wrong!Pass9", remember: false },
          TEST_LOGIN_CONFIG,
          ORIGIN,
        ),
      ).rejects.toThrow();
    }

    await authenticate(
      db.prisma,
      { identifier: "analyst", password: PASSWORD, remember: false },
      TEST_LOGIN_CONFIG,
      ORIGIN,
    );

    // A user who eventually remembers their password must not stay one typo
    // away from a lockout.
    const failures = await db.prisma.loginAttempt.count({ where: { successful: false } });
    expect(failures).toBe(0);
  });
});

describe("authenticate — rejection", () => {
  test("rejects a wrong password", async () => {
    await seedUser();

    await expect(
      authenticate(
        db.prisma,
        { identifier: "analyst", password: "Wrong!Pass9", remember: false },
        TEST_LOGIN_CONFIG,
        ORIGIN,
      ),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });

    expect(await actions()).toContain(AUDIT_ACTIONS.LOGIN_FAILED);
  });

  test("rejects an unknown identifier with the same code", async () => {
    await seedUser();

    // Identical code and message to a wrong password: the response must not
    // reveal whether the account exists.
    await expect(
      authenticate(
        db.prisma,
        { identifier: "nobody", password: PASSWORD, remember: false },
        TEST_LOGIN_CONFIG,
        ORIGIN,
      ),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
  });

  test("records a failed attempt against an account that does not exist", async () => {
    await authenticate(
      db.prisma,
      { identifier: "ghost", password: PASSWORD, remember: false },
      TEST_LOGIN_CONFIG,
      ORIGIN,
    ).catch(() => undefined);

    // Attempts against non-existent accounts must still be counted, or
    // enumerating usernames becomes rate-limit-free.
    const attempts = await db.prisma.loginAttempt.findMany();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.identifier).toBe("ghost");
  });

  test("reveals a disabled account only after the password is proven", async () => {
    await seedUser({ isActive: false });

    // Wrong password on a disabled account: still just bad credentials.
    await expect(
      authenticate(
        db.prisma,
        { identifier: "analyst", password: "Wrong!Pass9", remember: false },
        TEST_LOGIN_CONFIG,
        ORIGIN,
      ),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });

    // Correct password: now it is safe to say the account is disabled.
    await expect(
      authenticate(
        db.prisma,
        { identifier: "analyst", password: PASSWORD, remember: false },
        TEST_LOGIN_CONFIG,
        ORIGIN,
      ),
    ).rejects.toMatchObject({ code: "ACCOUNT_DISABLED" });
  });

  test("issues no session when authentication fails", async () => {
    await seedUser();

    await authenticate(
      db.prisma,
      { identifier: "analyst", password: "Wrong!Pass9", remember: false },
      TEST_LOGIN_CONFIG,
      ORIGIN,
    ).catch(() => undefined);

    expect(await db.prisma.session.count()).toBe(0);
  });
});

describe("authenticate — rate limiting", () => {
  test("locks the identifier after the configured number of failures", async () => {
    await seedUser();
    const config = {
      ...TEST_LOGIN_CONFIG,
      rateLimit: { maxAttempts: 3, windowSeconds: 900, lockoutSeconds: 900 },
    };

    for (let i = 0; i < 3; i += 1) {
      await authenticate(
        db.prisma,
        { identifier: "analyst", password: "Wrong!Pass9", remember: false },
        config,
        ORIGIN,
      ).catch(() => undefined);
    }

    // Even the correct password is refused while the lockout holds.
    await expect(
      authenticate(
        db.prisma,
        { identifier: "analyst", password: PASSWORD, remember: false },
        config,
        ORIGIN,
      ),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });

    expect(await actions()).toContain(AUDIT_ACTIONS.LOGIN_BLOCKED);
  });

  test("the lockout lifts once the window has passed", async () => {
    await seedUser();
    const config = {
      ...TEST_LOGIN_CONFIG,
      rateLimit: { maxAttempts: 2, windowSeconds: 60, lockoutSeconds: 60 },
    };
    const start = new Date("2026-01-01T00:00:00Z");

    for (let i = 0; i < 2; i += 1) {
      await authenticate(
        db.prisma,
        { identifier: "analyst", password: "Wrong!Pass9", remember: false },
        config,
        ORIGIN,
        start,
      ).catch(() => undefined);
    }

    const later = new Date(start.getTime() + 61_000);
    const result = await authenticate(
      db.prisma,
      { identifier: "analyst", password: PASSWORD, remember: false },
      config,
      ORIGIN,
      later,
    );

    expect(result.user.username).toBe("analyst");
  });
});

describe("authenticate — session handling", () => {
  test("destroys a pre-existing session token (fixation defence)", async () => {
    const user = await seedUser();

    // A token the browser already held — planted, or simply stale.
    const planted = await createSession(db.prisma, { userId: user.id, maxAgeSeconds: 3600 });

    await authenticate(
      db.prisma,
      { identifier: "analyst", password: PASSWORD, remember: false },
      TEST_LOGIN_CONFIG,
      { ...ORIGIN, existingToken: planted.token },
    );

    const { resolved } = await resolveSession(db.prisma, planted.token, {
      rolling: false,
      maxAgeSeconds: 3600,
    });
    expect(resolved).toBeNull();
  });

  test("the issued token resolves to the user", async () => {
    await seedUser();

    const result = await authenticate(
      db.prisma,
      { identifier: "analyst", password: PASSWORD, remember: false },
      TEST_LOGIN_CONFIG,
      ORIGIN,
    );

    const { resolved } = await resolveSession(db.prisma, result.token, {
      rolling: false,
      maxAgeSeconds: 3600,
    });
    expect(resolved?.user.username).toBe("analyst");
  });

  test("upgrades a hash written under weaker parameters", async () => {
    const weak = { memoryKib: 8192, iterations: 1, parallelism: 1 };
    const user = await seedUser({ passwordHash: await hashPassword(PASSWORD, weak) });

    await authenticate(
      db.prisma,
      { identifier: "analyst", password: PASSWORD, remember: false },
      { ...TEST_LOGIN_CONFIG, argon: { ...weak, iterations: 2 } },
      ORIGIN,
    );

    const after = await db.prisma.user.findUnique({ where: { id: user.id } });
    expect(after?.passwordHash).toContain("t=2");
    expect(after?.passwordHash).not.toBe(user.passwordHash);
  });
});

describe("logout", () => {
  test("revokes the session and audits it", async () => {
    const user = await seedUser();
    const result = await authenticate(
      db.prisma,
      { identifier: "analyst", password: PASSWORD, remember: false },
      TEST_LOGIN_CONFIG,
      ORIGIN,
    );

    await logout(db.prisma, result.token, { id: user.id, username: user.username }, ORIGIN);

    const { resolved } = await resolveSession(db.prisma, result.token, {
      rolling: false,
      maxAgeSeconds: 3600,
    });
    expect(resolved).toBeNull();
    expect(await actions()).toContain(AUDIT_ACTIONS.LOGOUT);
  });

  test("is idempotent", async () => {
    await expect(logout(db.prisma, "not-a-real-token", null, ORIGIN)).resolves.toBeUndefined();
  });
});

describe("changeOwnPassword", () => {
  test("requires the current password", async () => {
    const user = await seedUser();

    await expect(
      changeOwnPassword(
        db.prisma,
        { userId: user.id, currentPassword: "Wrong!Pass9", newPassword: "Petrel!77Gale" },
        TEST_ARGON2_PARAMS,
        ORIGIN,
      ),
    ).rejects.toMatchObject({ code: "INVALID_CREDENTIALS" });
  });

  test("changes the password, clears the forced-change flag and audits it", async () => {
    const user = await seedUser({ mustChangePassword: true });

    await changeOwnPassword(
      db.prisma,
      { userId: user.id, currentPassword: PASSWORD, newPassword: "Petrel!77Gale" },
      TEST_ARGON2_PARAMS,
      ORIGIN,
    );

    const after = await db.prisma.user.findUnique({ where: { id: user.id } });
    expect(after?.mustChangePassword).toBe(false);
    expect(after?.passwordHash).not.toBe(user.passwordHash);
    expect(await actions()).toContain(AUDIT_ACTIONS.PASSWORD_CHANGED);

    // The new password works and the old one does not.
    await expect(
      authenticate(
        db.prisma,
        { identifier: "analyst", password: "Petrel!77Gale", remember: false },
        TEST_LOGIN_CONFIG,
        ORIGIN,
      ),
    ).resolves.toBeTruthy();

    await expect(
      authenticate(
        db.prisma,
        { identifier: "analyst", password: PASSWORD, remember: false },
        TEST_LOGIN_CONFIG,
        ORIGIN,
      ),
    ).rejects.toThrow();
  });

  test("signs out other devices but keeps the current session", async () => {
    const user = await seedUser();

    const keep = await createSession(db.prisma, { userId: user.id, maxAgeSeconds: 3600 });
    const other = await createSession(db.prisma, { userId: user.id, maxAgeSeconds: 3600 });
    const keepId = (await db.prisma.session.findFirst({ orderBy: { createdAt: "asc" } }))?.id;

    await changeOwnPassword(
      db.prisma,
      {
        userId: user.id,
        currentPassword: PASSWORD,
        newPassword: "Petrel!77Gale",
        currentSessionId: keepId,
      },
      TEST_ARGON2_PARAMS,
      ORIGIN,
    );

    const survivors = await db.prisma.session.findMany();
    expect(survivors).toHaveLength(1);
    expect(survivors[0]?.id).toBe(keepId!);

    // Sanity: the two tokens really were different sessions.
    expect(keep.token).not.toBe(other.token);
  });
});
