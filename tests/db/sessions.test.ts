import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { hashPassword } from "@/server/auth/password";
import {
  createSession,
  hashSessionToken,
  listSessionsForUser,
  pruneExpiredSessions,
  resolveSession,
  revokeAllSessionsForUser,
  revokeSession,
} from "@/server/auth/sessions";

import { createTestDatabase, TEST_ARGON2_PARAMS, type TestDatabase } from "./helpers/test-db";

/**
 * Server-side session store.
 *
 * The two properties worth defending here are that the raw token never touches
 * the database, and that revocation is immediate — those are the reasons this
 * table exists instead of a self-contained signed cookie.
 */

const HOUR = 3600;
const OPTS = { rolling: false, maxAgeSeconds: HOUR };

let db: TestDatabase;

async function seedUser(overrides: Record<string, unknown> = {}) {
  return db.prisma.user.create({
    data: {
      username: "analyst",
      email: "analyst@sentinel.local",
      passwordHash: await hashPassword("Kestrel!42Vane", TEST_ARGON2_PARAMS),
      role: "Employee",
      isActive: true,
      ...overrides,
    },
  });
}

beforeEach(async () => {
  db = await createTestDatabase();
});

afterEach(async () => {
  await db.close();
});

describe("createSession", () => {
  test("stores the sha256 of the token, never the token", async () => {
    const user = await seedUser();
    const { token } = await createSession(db.prisma, { userId: user.id, maxAgeSeconds: HOUR });

    const rows = await db.prisma.session.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(await hashSessionToken(token));
    expect(rows[0]?.id).not.toBe(token);
    // A dump of this table must not yield anything replayable.
    expect(rows[0]?.id).toMatch(/^[0-9a-f]{64}$/);
  });

  test("issues a different token every time", async () => {
    const user = await seedUser();
    const a = await createSession(db.prisma, { userId: user.id, maxAgeSeconds: HOUR });
    const b = await createSession(db.prisma, { userId: user.id, maxAgeSeconds: HOUR });

    expect(a.token).not.toBe(b.token);
    expect(a.token.length).toBeGreaterThanOrEqual(40);
  });

  test("records origin and truncates an overlong user agent", async () => {
    const user = await seedUser();
    await createSession(db.prisma, {
      userId: user.id,
      maxAgeSeconds: HOUR,
      ipAddress: "10.0.0.9",
      userAgent: "x".repeat(2000),
    });

    const row = await db.prisma.session.findFirst();
    expect(row?.ipAddress).toBe("10.0.0.9");
    expect(row?.userAgent?.length).toBe(512);
  });
});

describe("resolveSession", () => {
  test("returns the user for a live token", async () => {
    const user = await seedUser();
    const { token } = await createSession(db.prisma, { userId: user.id, maxAgeSeconds: HOUR });

    const { resolved, reason } = await resolveSession(db.prisma, token, OPTS);
    expect(reason).toBe("ok");
    expect(resolved?.user.id).toBe(user.id);
    expect(resolved?.user.role).toBe("Employee");
  });

  test("rejects an unknown or empty token", async () => {
    expect((await resolveSession(db.prisma, "", OPTS)).reason).toBe("unknown");
    expect((await resolveSession(db.prisma, "made-up-token", OPTS)).reason).toBe("unknown");
  });

  test("rejects and deletes an expired session", async () => {
    const user = await seedUser();
    const start = new Date("2026-01-01T00:00:00Z");
    const { token } = await createSession(db.prisma, { userId: user.id, maxAgeSeconds: 60 }, start);

    const later = new Date(start.getTime() + 61_000);
    const { resolved, reason } = await resolveSession(db.prisma, token, OPTS, later);

    expect(resolved).toBeNull();
    expect(reason).toBe("expired");
    // Swept as it is encountered, so the table stays tidy without a scheduler.
    expect(await db.prisma.session.count()).toBe(0);
  });

  test("rejects a session whose account has been disabled", async () => {
    const user = await seedUser();
    const { token } = await createSession(db.prisma, { userId: user.id, maxAgeSeconds: HOUR });

    await db.prisma.user.update({ where: { id: user.id }, data: { isActive: false } });

    const { resolved, reason } = await resolveSession(db.prisma, token, OPTS);
    expect(resolved).toBeNull();
    expect(reason).toBe("disabled");
    // Every session for that account is dropped, not just the one presented.
    expect(await db.prisma.session.count()).toBe(0);
  });

  test("throws if the stored role is not recognised", async () => {
    // Failing closed: a row the code cannot interpret must not resolve to a
    // usable session under some assumed default.
    const user = await seedUser({ role: "Overlord" });
    const { token } = await createSession(db.prisma, { userId: user.id, maxAgeSeconds: HOUR });

    await expect(resolveSession(db.prisma, token, OPTS)).rejects.toThrow(/Unrecognised role/);
  });
});

describe("rolling sessions", () => {
  test("extends the expiry once past the refresh threshold", async () => {
    const user = await seedUser();
    const start = new Date("2026-01-01T00:00:00Z");
    const { token, expiresAt } = await createSession(
      db.prisma,
      { userId: user.id, maxAgeSeconds: 100 },
      start,
    );

    // 60% elapsed — past the halfway refresh point.
    const later = new Date(start.getTime() + 60_000);
    const { resolved } = await resolveSession(
      db.prisma,
      token,
      { rolling: true, maxAgeSeconds: 100 },
      later,
    );

    expect(new Date(resolved!.session.expiresAt).getTime()).toBeGreaterThan(expiresAt.getTime());
  });

  test("does not write on every request", async () => {
    const user = await seedUser();
    const start = new Date("2026-01-01T00:00:00Z");
    const { token, expiresAt } = await createSession(
      db.prisma,
      { userId: user.id, maxAgeSeconds: 100 },
      start,
    );

    // Only 10% elapsed. Writing here would take a SQLite write lock on every
    // single request for no benefit.
    const soon = new Date(start.getTime() + 10_000);
    const { resolved } = await resolveSession(
      db.prisma,
      token,
      { rolling: true, maxAgeSeconds: 100 },
      soon,
    );

    expect(new Date(resolved!.session.expiresAt).getTime()).toBe(expiresAt.getTime());
  });

  test("leaves the expiry alone when rolling is off", async () => {
    const user = await seedUser();
    const start = new Date("2026-01-01T00:00:00Z");
    const { token, expiresAt } = await createSession(
      db.prisma,
      { userId: user.id, maxAgeSeconds: 100 },
      start,
    );

    const later = new Date(start.getTime() + 90_000);
    const { resolved } = await resolveSession(db.prisma, token, OPTS, later);

    expect(new Date(resolved!.session.expiresAt).getTime()).toBe(expiresAt.getTime());
  });
});

describe("revocation", () => {
  test("revokeSession kills exactly one session", async () => {
    const user = await seedUser();
    const a = await createSession(db.prisma, { userId: user.id, maxAgeSeconds: HOUR });
    const b = await createSession(db.prisma, { userId: user.id, maxAgeSeconds: HOUR });

    await revokeSession(db.prisma, a.token);

    expect((await resolveSession(db.prisma, a.token, OPTS)).resolved).toBeNull();
    expect((await resolveSession(db.prisma, b.token, OPTS)).resolved).not.toBeNull();
  });

  test("revokeSession is idempotent and tolerates a bogus token", async () => {
    await expect(revokeSession(db.prisma, "nonsense")).resolves.toBeUndefined();
    await expect(revokeSession(db.prisma, "")).resolves.toBeUndefined();
  });

  test("revokeAllSessionsForUser can spare the current session", async () => {
    const user = await seedUser();
    await createSession(db.prisma, { userId: user.id, maxAgeSeconds: HOUR });
    await createSession(db.prisma, { userId: user.id, maxAgeSeconds: HOUR });
    const keep = await createSession(db.prisma, { userId: user.id, maxAgeSeconds: HOUR });
    const keepId = await hashSessionToken(keep.token);

    const revoked = await revokeAllSessionsForUser(db.prisma, user.id, keepId);

    expect(revoked).toBe(2);
    expect((await resolveSession(db.prisma, keep.token, OPTS)).resolved).not.toBeNull();
  });

  test("revokeAllSessionsForUser leaves other users alone", async () => {
    const a = await seedUser();
    const b = await seedUser({ username: "other", email: "other@sentinel.local" });

    await createSession(db.prisma, { userId: a.id, maxAgeSeconds: HOUR });
    const kept = await createSession(db.prisma, { userId: b.id, maxAgeSeconds: HOUR });

    await revokeAllSessionsForUser(db.prisma, a.id);

    expect((await resolveSession(db.prisma, kept.token, OPTS)).resolved).not.toBeNull();
  });

  test("deleting a user cascades to their sessions", async () => {
    const user = await seedUser();
    await createSession(db.prisma, { userId: user.id, maxAgeSeconds: HOUR });

    await db.prisma.user.delete({ where: { id: user.id } });

    expect(await db.prisma.session.count()).toBe(0);
  });
});

describe("housekeeping", () => {
  test("pruneExpiredSessions removes only expired rows", async () => {
    const user = await seedUser();
    const start = new Date("2026-01-01T00:00:00Z");

    await createSession(db.prisma, { userId: user.id, maxAgeSeconds: 60 }, start);
    const live = await createSession(db.prisma, { userId: user.id, maxAgeSeconds: 86_400 }, start);

    const later = new Date(start.getTime() + 61_000);
    const removed = await pruneExpiredSessions(db.prisma, later);

    expect(removed).toBe(1);
    // Resolved against the same clock the rows were created on — using the
    // real clock here would find the long-lived session expired too, since
    // `start` is a fixed date in the past.
    expect((await resolveSession(db.prisma, live.token, OPTS, later)).resolved).not.toBeNull();
  });

  test("listSessionsForUser shows live sessions without exposing tokens", async () => {
    const user = await seedUser();
    await createSession(db.prisma, {
      userId: user.id,
      maxAgeSeconds: HOUR,
      ipAddress: "10.0.0.3",
    });

    const sessions = await listSessionsForUser(db.prisma, user.id);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.ipAddress).toBe("10.0.0.3");
    expect(JSON.stringify(sessions)).not.toContain("token");
  });
});
