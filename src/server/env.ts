import { z } from "zod";

/**
 * Server-side environment configuration.
 *
 * The rest of the codebase reads `process.env` inline (see `src/utils/llm.ts`),
 * which is fine for optional feature keys — a missing LLM key degrades to a
 * visible "AI unavailable" state. Auth is different: a missing or too-short
 * SESSION_SECRET is not a degraded feature, it is a silently insecure one. So
 * these are validated once, loudly, and the process refuses to serve without
 * them.
 *
 * `parseAuthEnv` is a plain function over a plain record so it can be tested
 * without mutating the real environment.
 */

/** Minimum length the cookie sealing algorithm (AES-256) requires. */
export const SESSION_SECRET_MIN_LENGTH = 32;

const secondsSchema = z.coerce.number().int().positive();

const AuthEnvSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required — e.g. file:./data/sentinel.db"),

  SESSION_SECRET: z
    .string()
    .min(
      SESSION_SECRET_MIN_LENGTH,
      `SESSION_SECRET must be at least ${SESSION_SECRET_MIN_LENGTH} characters. ` +
        `Generate one with: node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`,
    ),

  /** Idle lifetime of a session. Default 8 hours — one duty shift. */
  SESSION_MAX_AGE: secondsSchema.default(28800),

  // OWASP baseline for Argon2id. Raising memory raises resistance to
  // GPU cracking but also raises login latency on the server.
  ARGON2_MEMORY_KIB: z.coerce.number().int().min(8192).default(19456),
  ARGON2_ITERATIONS: z.coerce.number().int().min(1).default(2),
  ARGON2_PARALLELISM: z.coerce.number().int().min(1).default(1),

  LOGIN_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(5),
  LOGIN_WINDOW_SECONDS: secondsSchema.default(900),
  LOGIN_LOCKOUT_SECONDS: secondsSchema.default(900),

  NODE_ENV: z.string().default("development"),
});

export type AuthEnv = z.infer<typeof AuthEnvSchema> & { isProduction: boolean };

export class EnvConfigurationError extends Error {
  readonly issues: string[];

  constructor(issues: string[]) {
    super(`Invalid server environment configuration:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
    this.name = "EnvConfigurationError";
    this.issues = issues;
  }
}

/**
 * Validate a raw environment record. Throws `EnvConfigurationError` listing
 * every problem at once rather than failing on the first — a half-configured
 * deployment should learn everything it is missing in one restart.
 */
export function parseAuthEnv(source: Record<string, string | undefined>): AuthEnv {
  const parsed = AuthEnvSchema.safeParse(source);

  if (!parsed.success) {
    throw new EnvConfigurationError(
      parsed.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`),
    );
  }

  return { ...parsed.data, isProduction: parsed.data.NODE_ENV === "production" };
}

let cached: AuthEnv | null = null;

/**
 * Validated environment for the current process, parsed on first use.
 *
 * Deliberately lazy rather than a module-level const: evaluating at import time
 * would make merely importing anything in this tree throw during the client
 * build, where these variables do not exist.
 */
export function authEnv(): AuthEnv {
  if (!cached) cached = parseAuthEnv(process.env);
  return cached;
}

/** Test-only: drop the memoised value so a fresh environment is re-read. */
export function resetAuthEnvCache(): void {
  cached = null;
}
