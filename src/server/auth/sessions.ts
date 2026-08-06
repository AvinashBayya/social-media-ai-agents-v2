import type { Role } from "@/lib/roles";
import { parseRole } from "@/lib/roles";

import type { Database } from "../db";

/**
 * Server-side session store.
 *
 * The cookie carries an opaque bearer token and nothing else; this table is
 * the authority on whether that token is still good. That split is what makes
 * revocation real — disabling an account or forcing a global logout takes
 * effect on the next request, which a self-contained signed cookie can never
 * do without waiting for it to expire.
 *
 * The token itself is never stored. The primary key is its SHA-256, so a dump
 * of this table yields no usable credentials, exactly as with password hashes.
 * Lookup is still a single indexed read because hashing is deterministic.
 */

/** 256 bits of entropy — far past guessable, and short enough for a cookie. */
const TOKEN_BYTES = 32;

/**
 * How much of the remaining lifetime must elapse before a rolling session is
 * extended. Without this, every request writes to the session row; SQLite
 * takes a write lock for each one, so a busy page turns into lock contention
 * for no benefit.
 */
const ROLLING_REFRESH_RATIO = 0.5;

export interface SessionUser {
  id: string;
  username: string;
  email: string;
  role: Role;
  isActive: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface ResolvedSession {
  user: SessionUser;
  session: {
    id: string;
    expiresAt: string;
    createdAt: string;
    lastSeenAt: string;
  };
}

/** Mint a token. Web Crypto so this stays free of node: imports. */
function generateToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);

  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * SHA-256 of a token, hex encoded — the stored primary key.
 * Exported for tests, which need to assert that the raw token never lands in
 * the database.
 */
export async function hashSessionToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function toSessionUser(row: {
  id: string;
  username: string;
  email: string;
  role: string;
  isActive: boolean;
  mustChangePassword: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
}): SessionUser {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    // Throws if the stored value is not a known role. A row the code cannot
    // interpret must fail closed, not be quietly downgraded or promoted.
    role: parseRole(row.role),
    isActive: row.isActive,
    mustChangePassword: row.mustChangePassword,
    lastLoginAt: row.lastLoginAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface CreateSessionInput {
  userId: string;
  maxAgeSeconds: number;
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * Open a session and return the token to put in the cookie.
 *
 * The token is returned exactly once and never recoverable afterwards. Callers
 * must not log it.
 */
export async function createSession(
  db: Database,
  input: CreateSessionInput,
  now: Date = new Date(),
): Promise<{ token: string; expiresAt: Date }> {
  const token = generateToken();
  const id = await hashSessionToken(token);
  const expiresAt = new Date(now.getTime() + input.maxAgeSeconds * 1000);

  await db.session.create({
    data: {
      id,
      userId: input.userId,
      expiresAt,
      createdAt: now,
      lastSeenAt: now,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent?.slice(0, 512) ?? null,
    },
  });

  return { token, expiresAt };
}

export interface ResolveOptions {
  /** Extend the expiry on activity. */
  rolling: boolean;
  maxAgeSeconds: number;
}

/**
 * Exchange a token for the session and its user.
 *
 * Returns null for every failure mode — unknown token, expired session,
 * disabled account — without distinguishing them to the caller, because the
 * caller's response is the same in all three cases. The reason is reported
 * separately via `reason` for auditing.
 *
 * Expired and orphaned rows are deleted as they are encountered, which keeps
 * the table tidy without a scheduled job.
 */
export async function resolveSession(
  db: Database,
  token: string,
  options: ResolveOptions,
  now: Date = new Date(),
): Promise<{
  resolved: ResolvedSession | null;
  reason: "ok" | "unknown" | "expired" | "disabled";
}> {
  if (!token) return { resolved: null, reason: "unknown" };

  const id = await hashSessionToken(token);
  const row = await db.session.findUnique({ where: { id }, include: { user: true } });

  if (!row) return { resolved: null, reason: "unknown" };

  if (row.expiresAt.getTime() <= now.getTime()) {
    await db.session.delete({ where: { id } }).catch(() => undefined);
    return { resolved: null, reason: "expired" };
  }

  // A disabled account's sessions are revoked at the point of disabling, but
  // re-checking here closes the window where a request is already in flight.
  if (!row.user.isActive) {
    await db.session.deleteMany({ where: { userId: row.userId } }).catch(() => undefined);
    return { resolved: null, reason: "disabled" };
  }

  let expiresAt = row.expiresAt;

  if (options.rolling) {
    const fullLife = options.maxAgeSeconds * 1000;
    const remaining = row.expiresAt.getTime() - now.getTime();

    if (remaining < fullLife * ROLLING_REFRESH_RATIO) {
      expiresAt = new Date(now.getTime() + fullLife);
      await db.session
        .update({ where: { id }, data: { expiresAt, lastSeenAt: now } })
        .catch(() => undefined);
    }
  }

  return {
    resolved: {
      user: toSessionUser(row.user),
      session: {
        id: row.id,
        expiresAt: expiresAt.toISOString(),
        createdAt: row.createdAt.toISOString(),
        lastSeenAt: row.lastSeenAt.toISOString(),
      },
    },
    reason: "ok",
  };
}

/** End one session. Idempotent — logging out twice is not an error. */
export async function revokeSession(db: Database, token: string): Promise<void> {
  if (!token) return;
  const id = await hashSessionToken(token);
  await db.session.deleteMany({ where: { id } });
}

/**
 * End every session for a user. Used when disabling an account, changing a
 * password, and by "sign out everywhere".
 *
 * `exceptSessionId` keeps the caller's own session alive, so changing your own
 * password logs out your other devices without logging out the tab you are
 * using to do it.
 */
export async function revokeAllSessionsForUser(
  db: Database,
  userId: string,
  exceptSessionId?: string,
): Promise<number> {
  const { count } = await db.session.deleteMany({
    where: {
      userId,
      ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}),
    },
  });
  return count;
}

/** Remove expired rows. Safe to call at any time. */
export async function pruneExpiredSessions(db: Database, now: Date = new Date()): Promise<number> {
  const { count } = await db.session.deleteMany({ where: { expiresAt: { lte: now } } });
  return count;
}

/** Live sessions for a user, newest first — for the admin detail view. */
export async function listSessionsForUser(db: Database, userId: string, now: Date = new Date()) {
  const rows = await db.session.findMany({
    where: { userId, expiresAt: { gt: now } },
    orderBy: { lastSeenAt: "desc" },
  });

  return rows.map((row) => ({
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
  }));
}
