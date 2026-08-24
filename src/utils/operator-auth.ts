/**
 * Server-side gate for the credential vault's write and verify paths.
 *
 * WHAT THIS IS, AND WHAT IT DELIBERATELY IS NOT.
 *
 * This is NOT a user system. There are no accounts, no password hashing, no
 * sessions and no roles. `src/utils/demo-session.ts` remains the (disclosed,
 * client-side, non-security) sign-in flow for the demo, and this module does
 * not replace it.
 *
 * What it is: a single shared operator token, compared in constant time on the
 * server, guarding the handful of server functions that can write or test a
 * stored secret. That is a deliberately small mechanism chosen over restoring
 * the reverted Prisma/SQLite/Argon2id stack at `214f0df`, because:
 *
 *   - that stack needs a database this deployment does not have;
 *   - it gated ROUTES, which is what broke v10 — every page behind a login no
 *     source in the tree produced;
 *   - and by its own AUTH.md it never guarded the server functions at all,
 *     which is the actual hole.
 *
 * FAIL-CLOSED WHEN CONFIGURED, DISCLOSED WHEN NOT. If `SENTINEL_OPERATOR_TOKEN`
 * is set, every guarded call must present it or is refused. If it is unset, the
 * guarded calls still work — otherwise setting no env var would brick the demo's
 * Settings page — but `vaultAuthStatus()` reports `unprotected`, the UI shows it,
 * and the server logs it once at first use. An undisclosed open door is the
 * problem; a disclosed one an operator can close with one env var is a
 * documented limitation, which is the same treatment `data/` durability and
 * Jetstream forward-only collection already get.
 *
 * The token never crosses to the browser. It is compared against a header the
 * operator's own tooling supplies.
 */

import { createHash, timingSafeEqual } from "node:crypto";

import { NotAuthorisedError } from "./operational-error";

/** Header carrying the operator token on a guarded server-function call. */
export const OPERATOR_TOKEN_HEADER = "x-sentinel-operator-token";

export type VaultAuthMode = "protected" | "unprotected";

export interface VaultAuthStatus {
  mode: VaultAuthMode;
  /** Operator-facing explanation. Rendered on /settings. Never a placeholder. */
  detail: string;
  /** The env var that changes this. Named so the UI can tell the operator. */
  envVar: string;
}

/** Minimum length below which a configured token is treated as absent. */
export const MIN_TOKEN_LENGTH = 16;

/**
 * Read the configured token.
 *
 * A token shorter than MIN_TOKEN_LENGTH is REFUSED rather than accepted, and
 * warns. Accepting `"test"` would let a deployment believe it is protected
 * while being trivially guessable — the failure mode where a security control
 * reports success it has not earned.
 */
export function configuredOperatorToken(
  env: Record<string, string | undefined> = process.env,
  warn: (msg: string) => void = console.warn,
): string | null {
  const raw = (env.SENTINEL_OPERATOR_TOKEN ?? "").trim();
  if (!raw) return null;
  if (raw.length < MIN_TOKEN_LENGTH) {
    warn(
      `operator-auth: SENTINEL_OPERATOR_TOKEN is only ${raw.length} characters. ` +
        `Refusing to treat it as configured — a guessable token is worse than a ` +
        `disclosed open one, because it reports protection it does not provide. ` +
        `Use at least ${MIN_TOKEN_LENGTH} characters.`,
    );
    return null;
  }
  return raw;
}

export function vaultAuthStatus(
  env: Record<string, string | undefined> = process.env,
  warn: (msg: string) => void = () => {},
): VaultAuthStatus {
  const token = configuredOperatorToken(env, warn);
  if (token) {
    return {
      mode: "protected",
      detail:
        "Credential writes, deletes and verification require the operator token. " +
        "Requests without it are refused.",
      envVar: "SENTINEL_OPERATOR_TOKEN",
    };
  }
  return {
    mode: "unprotected",
    detail:
      "No operator token is configured, so credential writes are reachable by anyone who " +
      "can reach this deployment. Stored secrets are never readable — the vault is " +
      "write-only and no server function returns a secret — but an unauthenticated caller " +
      "can add, overwrite or delete an entry. Set SENTINEL_OPERATOR_TOKEN to close this.",
    envVar: "SENTINEL_OPERATOR_TOKEN",
  };
}

/**
 * Constant-time comparison of two secrets.
 *
 * Both sides are hashed first so `timingSafeEqual` always sees equal-length
 * buffers — it throws on a length mismatch, and catching that throw would
 * itself be a length oracle.
 */
export function tokensMatch(supplied: string, expected: string): boolean {
  if (!supplied || !expected) return false;
  const a = createHash("sha256").update(supplied).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

let warnedUnprotected = false;

/**
 * Guard a credential-vault mutation.
 *
 * Throws `NotAuthorisedError` when a token is configured and the request does
 * not carry a matching one. When no token is configured it permits the call and
 * logs once — see the module header for why that is a disclosed limitation
 * rather than a silent bypass.
 */
export function requireOperator(
  action: string,
  suppliedToken: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
  log: (msg: string) => void = console.warn,
): void {
  const expected = configuredOperatorToken(env, log);

  if (!expected) {
    if (!warnedUnprotected) {
      warnedUnprotected = true;
      log(
        `operator-auth: "${action}" ran without authentication because ` +
          `SENTINEL_OPERATOR_TOKEN is not set. Credential writes are open to any caller ` +
          `that can reach this deployment. This is reported on /settings.`,
      );
    }
    return;
  }

  if (!suppliedToken || !tokensMatch(suppliedToken, expected)) {
    throw new NotAuthorisedError(action);
  }
}

/** Test seam: reset the once-only warning latch. */
export function resetOperatorAuthWarning(): void {
  warnedUnprotected = false;
}

/**
 * Pull the token out of request headers.
 *
 * Accepts `Authorization: Bearer <token>` as well as the dedicated header, so
 * ordinary HTTP tooling works without a custom header flag.
 */
export function operatorTokenFrom(headers: { get(name: string): string | null }): string | null {
  const direct = headers.get(OPERATOR_TOKEN_HEADER);
  if (direct && direct.trim()) return direct.trim();

  const auth = headers.get("authorization") ?? "";
  const bearer = /^Bearer\s+(.+)$/i.exec(auth.trim());
  return bearer ? bearer[1].trim() : null;
}
