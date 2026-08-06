import {
  clearSession,
  getRequestHeader,
  getRequestIP,
  useSession,
} from "@tanstack/react-start/server";

import type { Role } from "@/lib/roles";

import { db } from "../db";
import { authEnv } from "../env";
import { logger } from "../logger";
import { AUDIT_ACTIONS, recordAudit, type RequestOrigin } from "./audit";
import { resolveSession, type ResolvedSession } from "./sessions";

/**
 * Request-scoped auth context.
 *
 * Two layers of cookie handling are in play and it is worth being precise
 * about why both exist:
 *
 *  - The framework's `useSession` seals an encrypted, HttpOnly cookie for us
 *    (AES-256-CBC + SHA-256 integrity, via h3). We use it purely as a
 *    tamper-proof envelope.
 *  - Inside that envelope sits nothing but an opaque session token, which is
 *    looked up in the Session table on every request.
 *
 * A sealed cookie alone would be a stateless session: fast, but impossible to
 * revoke before it expires. Putting the database in the path is what makes
 * "disable this account" and "sign out everywhere" take effect immediately.
 * The seal is still worth having — it stops the token being read or replayed
 * from a stolen cookie jar without the server secret.
 */

/** Cookie name. Deliberately generic — it advertises no framework or product. */
const SESSION_COOKIE_NAME = "sentinel_sid";

interface SessionCookiePayload extends Record<string, unknown> {
  token?: string;
}

function sessionConfig() {
  const env = authEnv();

  return {
    name: SESSION_COOKIE_NAME,
    password: env.SESSION_SECRET,
    maxAge: env.SESSION_MAX_AGE,
    // Disabled. Left on, the framework would also accept a session presented
    // in an `x-sentinel_sid-session` header, which is a transport we never use
    // and therefore only widens the attack surface.
    sessionHeader: false as const,
    cookie: {
      httpOnly: true,
      // Strict, not Lax: nothing in this app is meant to be reached by
      // following a link from another site, so there is no flow to break.
      sameSite: "strict" as const,
      path: "/",
      // Secure everywhere except plain-HTTP local development, where the
      // browser would silently drop the cookie and make login appear broken.
      secure: env.isProduction,
      maxAge: env.SESSION_MAX_AGE,
    },
  };
}

/** IP and user-agent for audit rows. */
export function requestOrigin(): RequestOrigin {
  let ipAddress: string | null = null;
  try {
    // xForwardedFor: the app sits behind a reverse proxy (Container Apps
    // ingress, or nginx on an intranet host), so the socket address is the
    // proxy's. On a private network the header is as trustworthy as the
    // network itself; it is recorded for forensics, never for authorisation.
    ipAddress = getRequestIP({ xForwardedFor: true }) ?? null;
  } catch {
    ipAddress = null;
  }

  let userAgent: string | null = null;
  try {
    userAgent = getRequestHeader("user-agent") ?? null;
  } catch {
    userAgent = null;
  }

  return { ipAddress, userAgent };
}

/** Read the opaque token out of the sealed cookie. */
export async function readSessionToken(): Promise<string | null> {
  try {
    const session = await useSession<SessionCookiePayload>(sessionConfig());
    return session.data.token ?? null;
  } catch (error) {
    // A malformed or undecryptable cookie — most often one sealed with a
    // previous SESSION_SECRET. Treated as "no session", which is what a
    // secret rotation is supposed to mean.
    logger.debug("session cookie unreadable", { error });
    return null;
  }
}

/** Put a freshly minted token into the cookie. */
export async function writeSessionToken(token: string): Promise<void> {
  const session = await useSession<SessionCookiePayload>(sessionConfig());
  await session.update({ token });
}

/** Remove the cookie entirely. */
export async function clearSessionCookie(): Promise<void> {
  try {
    await clearSession(sessionConfig());
  } catch (error) {
    logger.debug("failed to clear session cookie", { error });
  }
}

export interface AuthContext {
  user: ResolvedSession["user"] | null;
  session: ResolvedSession["session"] | null;
  origin: RequestOrigin;
}

/** An unauthenticated context — still carries origin, so denials are auditable. */
export function anonymousContext(): AuthContext {
  return { user: null, session: null, origin: requestOrigin() };
}

/**
 * Resolve the current request's auth context.
 *
 * Never throws for the unauthenticated case: "not signed in" is an ordinary
 * state that the login page and public routes rely on. It only throws if the
 * database itself is unreachable, which is a genuine fault.
 */
export async function currentAuth(): Promise<AuthContext> {
  const origin = requestOrigin();
  const token = await readSessionToken();

  if (!token) return { user: null, session: null, origin };

  const env = authEnv();
  const { resolved, reason } = await resolveSession(db(), token, {
    rolling: true,
    maxAgeSeconds: env.SESSION_MAX_AGE,
  });

  if (!resolved) {
    // The cookie referenced a session that is gone. Drop it so the browser
    // stops presenting it on every subsequent request.
    await clearSessionCookie();

    if (reason === "expired" || reason === "disabled") {
      await recordAudit(db(), {
        action:
          reason === "expired" ? AUDIT_ACTIONS.SESSION_EXPIRED : AUDIT_ACTIONS.SESSION_REVOKED,
        detail: { reason },
        ipAddress: origin.ipAddress,
        userAgent: origin.userAgent,
      });
    }

    return { user: null, session: null, origin };
  }

  return { user: resolved.user, session: resolved.session, origin };
}

/** Convenience for audit calls that need the acting user. */
export function actorFrom(context: AuthContext): {
  id: string;
  username: string;
  role: Role;
  ipAddress?: string | null;
  userAgent?: string | null;
} | null {
  if (!context.user) return null;
  return {
    id: context.user.id,
    username: context.user.username,
    role: context.user.role,
    ipAddress: context.origin.ipAddress,
    userAgent: context.origin.userAgent,
  };
}
