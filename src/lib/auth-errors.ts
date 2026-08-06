/**
 * Auth error codes shared by server and browser.
 *
 * This module is isomorphic on purpose: the server tags every auth failure
 * with one of these codes and the browser switches on it to decide whether to
 * show an inline message, redirect to login, or send the user to /forbidden.
 *
 * IMPORTANT — how a code actually reaches the browser. It is *returned*, not
 * thrown. Verified against a running server: router-core serialises a thrown
 * Error through its `ShallowErrorPlugin`, which keeps only `message` and
 * reconstructs a plain `new Error(message)` on the client. Custom properties
 * are dropped, so a thrown AuthError arrives with `code` and `fieldErrors`
 * gone and the login form cannot tell a validation failure from a rejected
 * password. Endpoints a user can legitimately fail therefore return the
 * `AuthResult` union in src/server/auth/functions.ts instead of throwing.
 *
 * `authErrorCodeOf` below still exists for the throw path, which remains in
 * use for guard failures on endpoints where the only correct client response
 * is to redirect — there the message is enough.
 *
 * Never widen these into free strings. The browser must be able to handle an
 * unrecognised code, but it should never have to parse a message.
 */

export const AUTH_ERROR_CODES = [
  /** No session, or the session presented has expired or been revoked. */
  "UNAUTHENTICATED",
  /** Authenticated, but the role lacks the required capability. */
  "FORBIDDEN",
  /** Username/password combination rejected. Deliberately non-specific. */
  "INVALID_CREDENTIALS",
  /** Account exists but has been disabled by an administrator. */
  "ACCOUNT_DISABLED",
  /** Too many failed attempts; the identifier or IP is temporarily locked. */
  "RATE_LIMITED",
  /** Request body failed validation. */
  "VALIDATION_FAILED",
  /** Username or email already taken. */
  "CONFLICT",
  /** Referenced record does not exist. */
  "NOT_FOUND",
  /** Session is valid but the account must set a new password first. */
  "PASSWORD_CHANGE_REQUIRED",
] as const;

export type AuthErrorCode = (typeof AUTH_ERROR_CODES)[number];

/** HTTP status paired with each code, used by both throw sites and handlers. */
export const AUTH_ERROR_STATUS: Record<AuthErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  INVALID_CREDENTIALS: 401,
  ACCOUNT_DISABLED: 403,
  RATE_LIMITED: 429,
  VALIDATION_FAILED: 400,
  CONFLICT: 409,
  NOT_FOUND: 404,
  PASSWORD_CHANGE_REQUIRED: 403,
};

/**
 * Copy shown to the user. Kept vague where being specific would help an
 * attacker: a failed login never reveals whether the username existed.
 */
export const AUTH_ERROR_MESSAGE: Record<AuthErrorCode, string> = {
  UNAUTHENTICATED: "Your session has ended. Sign in again to continue.",
  FORBIDDEN: "Your role does not permit this action.",
  INVALID_CREDENTIALS: "Incorrect username or password.",
  ACCOUNT_DISABLED: "This account has been disabled. Contact an administrator.",
  RATE_LIMITED: "Too many failed attempts. Try again shortly.",
  VALIDATION_FAILED: "Some of the details provided are not valid.",
  CONFLICT: "That username or email is already in use.",
  NOT_FOUND: "The requested record no longer exists.",
  PASSWORD_CHANGE_REQUIRED: "You must set a new password before continuing.",
};

function isAuthErrorCode(value: unknown): value is AuthErrorCode {
  return typeof value === "string" && (AUTH_ERROR_CODES as readonly string[]).includes(value);
}

/**
 * Read the auth error code off a value caught from a server function.
 * Returns null for anything that is not one of ours, so callers can fall
 * through to generic error handling rather than mislabelling a network fault
 * as a permission problem.
 */
export function authErrorCodeOf(error: unknown): AuthErrorCode | null {
  if (error == null || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  return isAuthErrorCode(code) ? code : null;
}

/** True when the caught error means "no usable session" — re-login required. */
export function isSessionEndedError(error: unknown): boolean {
  const code = authErrorCodeOf(error);
  return code === "UNAUTHENTICATED";
}

/**
 * Best-effort user-facing message for anything caught from a server function.
 * Falls back to the raw message so a genuine upstream failure is still shown
 * verbatim rather than replaced with invented reassurance.
 */
export function authErrorMessage(error: unknown, fallback = "Something went wrong."): string {
  const code = authErrorCodeOf(error);
  if (code) return AUTH_ERROR_MESSAGE[code];

  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return fallback;
}
