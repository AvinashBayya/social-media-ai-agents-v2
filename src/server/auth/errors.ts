import { AUTH_ERROR_MESSAGE, AUTH_ERROR_STATUS, type AuthErrorCode } from "@/lib/auth-errors";

/**
 * Errors thrown by the auth layer.
 *
 * Two properties are load-bearing and must not be dropped:
 *
 *  - `statusCode` — the global `errorMiddleware` in src/start.ts rethrows any
 *    error carrying it and converts everything else into a generic 500 HTML
 *    page. Without it, a 403 reaches the browser as "the page didn't load".
 *
 *  - `code` — survives serialisation to the client, which switches on it to
 *    decide between an inline message, a redirect to /login, and /forbidden.
 *
 * Messages come from a fixed table rather than being composed at the throw
 * site, so nothing internal leaks into a response. Detail useful for
 * operators goes in `detail`, which is logged and never serialised to the
 * browser.
 */
export class AuthError extends Error {
  readonly code: AuthErrorCode;
  readonly statusCode: number;
  /** Operator-facing context. Logged server-side; never sent to the client. */
  readonly detail?: string;
  /** Field-level problems, for form rendering. Safe to send. */
  readonly fieldErrors?: Record<string, string>;

  constructor(
    code: AuthErrorCode,
    options: { detail?: string; fieldErrors?: Record<string, string>; message?: string } = {},
  ) {
    super(options.message ?? AUTH_ERROR_MESSAGE[code]);
    this.name = "AuthError";
    this.code = code;
    this.statusCode = AUTH_ERROR_STATUS[code];
    this.detail = options.detail;
    this.fieldErrors = options.fieldErrors;

    // `detail` must not ride along to the browser. Making it non-enumerable
    // keeps it out of seroval's serialisation, which copies own enumerable
    // properties.
    Object.defineProperty(this, "detail", { value: options.detail, enumerable: false });
  }
}

export const unauthenticated = (detail?: string) => new AuthError("UNAUTHENTICATED", { detail });

export const forbidden = (detail?: string) => new AuthError("FORBIDDEN", { detail });

export const invalidCredentials = (detail?: string) =>
  new AuthError("INVALID_CREDENTIALS", { detail });

export const accountDisabled = (detail?: string) => new AuthError("ACCOUNT_DISABLED", { detail });

export const rateLimited = (detail?: string) => new AuthError("RATE_LIMITED", { detail });

export const conflict = (detail?: string, fieldErrors?: Record<string, string>) =>
  new AuthError("CONFLICT", { detail, fieldErrors });

export const notFound = (detail?: string) => new AuthError("NOT_FOUND", { detail });

export const validationFailed = (fieldErrors: Record<string, string>, detail?: string) =>
  new AuthError("VALIDATION_FAILED", { detail, fieldErrors });

export const passwordChangeRequired = () => new AuthError("PASSWORD_CHANGE_REQUIRED");

export function isAuthError(error: unknown): error is AuthError {
  return error instanceof AuthError;
}
