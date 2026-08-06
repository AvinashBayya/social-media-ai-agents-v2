import { createServerFn } from "@tanstack/react-start";

import { AUTH_ERROR_MESSAGE, type AuthErrorCode } from "@/lib/auth-errors";
import {
  ChangePasswordSchema,
  LoginSchema,
  fieldErrorsFrom,
  type ChangePasswordInput,
  type LoginInput,
} from "@/lib/auth-schemas";
import { permissionsFor, type Permission, type Role } from "@/lib/roles";

import { db } from "../db";
import { argonParams, loginConfig } from "./config";
import {
  clearSessionCookie,
  currentAuth,
  readSessionToken,
  requestOrigin,
  writeSessionToken,
} from "./context";
import { isAuthError } from "./errors";
import { requireAuth } from "./guards";
import { authenticate, changeOwnPassword, logout as logoutService } from "./login";
import type { SessionUser } from "./sessions";

/**
 * The auth API.
 *
 * These are TanStack server functions rather than HTTP route handlers. The
 * choice is deliberate: `src/start.ts` registers `createCsrfMiddleware` with
 * `filter: ctx => ctx.handlerType === "serverFn"`, so server functions are
 * CSRF-protected automatically while a hand-rolled route under /api would not
 * be. Adding raw routes would mean re-implementing that protection to gain
 * nothing but a prettier URL.
 *
 * The mapping to the endpoints in the specification is:
 *   POST /login   -> login()
 *   POST /logout  -> logout()
 *   GET  /me      -> fetchMe()
 *   GET  /session -> fetchSession()
 *
 * Validators are typed passthroughs and the real parse happens inside the
 * handler. That matches the existing convention in src/utils/llm.ts, and it
 * lets a validation failure come back as field-level messages the login form
 * can render instead of the framework's raw issue dump.
 */

/** What the browser is told about the signed-in user. Never includes a hash. */
export interface AuthState {
  user:
    | (SessionUser & {
        /** Resolved capabilities, so the UI does not re-derive the role table. */
        permissions: Permission[];
      })
    | null;
  session: { expiresAt: string; lastSeenAt: string } | null;
}

const SIGNED_OUT: AuthState = { user: null, session: null };

function toAuthState(
  user: SessionUser,
  session: { expiresAt: string; lastSeenAt: string },
): AuthState {
  return {
    user: { ...user, permissions: permissionsFor(user.role as Role) },
    session: { expiresAt: session.expiresAt, lastSeenAt: session.lastSeenAt },
  };
}

/**
 * Outcome of an operation the user can legitimately fail.
 *
 * Returned as data rather than thrown, and the reason is worth recording.
 * TanStack serialises every thrown Error through router-core's
 * `ShallowErrorPlugin`, which by design keeps *only* `message` and rebuilds a
 * plain `new Error(message)` on the client — it has to, so that things like a
 * ZodError with functions attached can cross the wire at all. Custom
 * properties do not survive, so a thrown AuthError arrives with `code` and
 * `fieldErrors` stripped and the login form cannot tell a validation failure
 * from a rejected password.
 *
 * Returning the failure keeps that information intact, and it is the more
 * honest model anyway: a wrong password is an expected outcome of signing in,
 * not an exceptional condition. Genuine faults — a dead database, a bug — do
 * still throw, and are handled by the error middleware in src/start.ts.
 */
export type AuthResult =
  | { ok: true; state: AuthState }
  | {
      ok: false;
      code: AuthErrorCode;
      message: string;
      fieldErrors?: Record<string, string>;
    };

/** Convert a thrown AuthError into the failure half of AuthResult. */
function asFailure(error: unknown): Extract<AuthResult, { ok: false }> {
  if (isAuthError(error)) {
    return {
      ok: false,
      code: error.code,
      message: error.message,
      ...(error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}),
    };
  }
  // Not one of ours — a real fault. Let the error middleware deal with it
  // rather than dressing it up as a failed login.
  throw error;
}

// ─── POST /login ───────────────────────────────────────────────────────────

export const login = createServerFn({ method: "POST" })
  .validator((data: LoginInput) => data)
  .handler(async ({ data }): Promise<AuthResult> => {
    const parsed = LoginSchema.safeParse(data);
    if (!parsed.success) {
      return {
        ok: false,
        code: "VALIDATION_FAILED",
        message: AUTH_ERROR_MESSAGE.VALIDATION_FAILED,
        fieldErrors: fieldErrorsFrom(parsed.error),
      };
    }

    const origin = requestOrigin();

    // Any cookie already present is handed to `authenticate` so it can destroy
    // that session before minting a new one — session fixation defence.
    const existingToken = await readSessionToken();

    try {
      const result = await authenticate(db(), parsed.data, loginConfig(), {
        ...origin,
        existingToken,
      });

      await writeSessionToken(result.token);

      return {
        ok: true,
        state: toAuthState(result.user, {
          expiresAt: result.expiresAt.toISOString(),
          lastSeenAt: new Date().toISOString(),
        }),
      };
    } catch (error) {
      return asFailure(error);
    }
  });

// ─── POST /logout ──────────────────────────────────────────────────────────

export const logout = createServerFn({ method: "POST" }).handler(async (): Promise<AuthState> => {
  const context = await currentAuth();
  const token = await readSessionToken();

  await logoutService(
    db(),
    token,
    context.user ? { id: context.user.id, username: context.user.username } : null,
    context.origin,
  );

  // Cleared unconditionally: logging out with an already-dead session must
  // still remove the cookie rather than leaving the browser to keep sending it.
  await clearSessionCookie();

  return SIGNED_OUT;
});

// ─── GET /session ──────────────────────────────────────────────────────────

/**
 * The current auth state, or the signed-out state.
 *
 * Does not throw when there is no session — the root route calls this on every
 * navigation to decide whether to redirect, and an exception there would mean
 * the login page itself could not render.
 */
export const fetchSession = createServerFn({ method: "GET" }).handler(
  async (): Promise<AuthState> => {
    const context = await currentAuth();
    if (!context.user || !context.session) return SIGNED_OUT;
    return toAuthState(context.user, context.session);
  },
);

// ─── GET /me ───────────────────────────────────────────────────────────────

/** The signed-in user. Throws UNAUTHENTICATED when there is no session. */
export const fetchMe = createServerFn({ method: "GET" }).handler(async (): Promise<AuthState> => {
  const context = await requireAuth();
  return toAuthState(context.user, context.session);
});

// ─── POST /change-password ─────────────────────────────────────────────────

export const changePassword = createServerFn({ method: "POST" })
  .validator((data: ChangePasswordInput) => data)
  .handler(async ({ data }): Promise<AuthResult> => {
    // requireAuth, not requireActiveSession: an account flagged
    // mustChangePassword must be able to reach exactly this endpoint. A
    // missing session still throws — that is not a failure the form can show,
    // it means the user must sign in again.
    const context = await requireAuth();

    const parsed = ChangePasswordSchema.safeParse(data);
    if (!parsed.success) {
      return {
        ok: false,
        code: "VALIDATION_FAILED",
        message: AUTH_ERROR_MESSAGE.VALIDATION_FAILED,
        fieldErrors: fieldErrorsFrom(parsed.error),
      };
    }

    try {
      await changeOwnPassword(
        db(),
        {
          userId: context.user.id,
          currentPassword: parsed.data.currentPassword,
          newPassword: parsed.data.password,
          currentSessionId: context.session.id,
        },
        argonParams(),
        context.origin,
      );
    } catch (error) {
      // A wrong current password lands here and is reported on the form
      // rather than blowing up the page.
      return asFailure(error);
    }

    // Re-read so the returned state carries mustChangePassword: false and the
    // client stops redirecting to the change screen.
    const refreshed = await currentAuth();
    if (!refreshed.user || !refreshed.session) {
      return { ok: true, state: SIGNED_OUT };
    }
    return { ok: true, state: toAuthState(refreshed.user, refreshed.session) };
  });
