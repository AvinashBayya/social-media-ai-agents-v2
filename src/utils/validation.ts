/**
 * Runtime input contracts for server functions.
 *
 * THE PROBLEM THIS SOLVES. Every one of the project's ~52 `createServerFn`
 * definitions shipped a validator of the form `.validator((d: { text: string }) => d)`.
 * That is a TypeScript annotation and nothing more — it is erased at build, so
 * at runtime `d` is whatever JSON the caller posted. The types described a
 * contract the server never enforced.
 *
 * WHY `validate()` WRAPS THE SCHEMA INSTEAD OF PASSING IT BARE. TanStack's
 * `execValidator` (start-client-core/dist/esm/createServerFn.js) dispatches on
 * Standard Schema first, then `.parse`, then a plain function. A bare zod
 * schema takes the Standard Schema branch, and on failure throws
 * `new Error(JSON.stringify(result.issues, null, 2))` — a JSON blob of the full
 * input path structure, serialized to the browser and rendered in a toast.
 * Passing a plain function takes the last branch, which lets us raise one
 * error class with a short operator-facing message that never echoes the
 * offending value.
 *
 * That error class deliberately mirrors `ContractViolationError` in
 * types/core.ts rather than inventing a second error vocabulary: same idea
 * (a shape was promised and not delivered), same reporting discipline.
 *
 * REJECT, DO NOT SANITISE. Every primitive below refuses bad input rather than
 * cleaning it. Cleaning changes what the analyst asked for without telling
 * them, which in an intelligence tool is its own kind of fabrication.
 */

import { z } from "zod";

// ─── Error ─────────────────────────────────────────────────────────────────

/**
 * Raised when a server function's input does not match its contract.
 *
 * `message` names the contract and the failing field PATHS only. The offending
 * VALUES are kept in `issues` for the server-side log and are never part of the
 * message — echoing an attacker's payload back is a reflection primitive, and
 * it is also how a credential pasted into the wrong box ends up in a log line
 * someone screenshots.
 */
export class InputContractError extends Error {
  readonly contract: string;
  readonly paths: string[];
  readonly issues: { path: string; message: string }[];

  constructor(contract: string, issues: { path: string; message: string }[]) {
    const paths = issues.map((i) => i.path || "(root)");
    super(
      `${contract} rejected the request: ${issues
        .map((i) => `${i.path || "(root)"} ${i.message}`)
        .join("; ")}`,
    );
    this.name = "InputContractError";
    this.contract = contract;
    this.paths = paths;
    this.issues = issues;
  }
}

/**
 * Wrap a schema as a `.validator()`-compatible plain function.
 *
 * Refinements only — never a shape-changing `.transform()` on a schema passed
 * here, because `z.output` is what the handler receives and a silent reshape
 * would break the handler's assumptions without a type error at the call site.
 */
export function validate<S extends z.ZodTypeAny>(
  schema: S,
  contract: string,
): (input: unknown) => z.infer<S> {
  return (input: unknown) => {
    const result = schema.safeParse(input);
    if (result.success) return result.data;
    throw new InputContractError(
      contract,
      result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  };
}

// ─── String primitives ─────────────────────────────────────────────────────

/** Non-empty trimmed text with a hard ceiling. */
export function boundedText(max: number, label = "text") {
  return z
    .string({ invalid_type_error: `must be a string` })
    .trim()
    .min(1, `${label} must not be empty`)
    .max(max, `${label} must be ${max} characters or fewer`);
}

export function boundedOptionalText(max: number, label = "text") {
  return boundedText(max, label).optional();
}

/**
 * Identifier-shaped: ids, provider keys, handles, subreddit names.
 *
 * Excludes whitespace, quotes, angle brackets and `/`. The explicit `..`
 * rejection matters even though no caller currently builds a path from one of
 * these: `../../etc/passwd` is otherwise a valid "identifier" under a
 * dot-permitting character class, and the next person to interpolate an id
 * into a path would inherit a traversal for free.
 */
export function identifierLike(max = 128, label = "identifier") {
  return z
    .string()
    .trim()
    .min(1, `${label} must not be empty`)
    .max(max, `${label} must be ${max} characters or fewer`)
    .regex(/^[\w.\-:@]+$/u, `${label} contains characters that are not permitted`)
    .refine((v) => !v.includes(".."), `${label} must not contain ".."`);
}

/**
 * A hashtag, with or without the leading `#`.
 *
 * `\p{M}` is load-bearing, not decoration. Indic scripts encode vowel signs and
 * viramas as COMBINING MARKS, which are neither `\p{L}` nor `\p{N}` — so
 * `[\p{L}\p{N}_]` rejects "सुरक्षा" outright while accepting the bare
 * consonants. On a platform whose whole point is 15 Indian languages that is
 * not a corner case. Same class of defect as the entity-key regex that once
 * covered only U+0900–U+0DFF and merged every Urdu name into one key.
 */
export const hashtagPattern = z
  .string()
  .trim()
  .min(1, "hashtag must not be empty")
  .max(100, "hashtag must be 100 characters or fewer")
  .regex(/^#?[\p{L}\p{M}\p{N}_]+$/u, "hashtag may contain only letters, numbers and underscores");

/** Telegram public channel handle. Mirrors the guard already in social.ts. */
export const telegramChannelPattern = z
  .string()
  .trim()
  .regex(/^@?[A-Za-z0-9_]{3,64}$/, "not a valid Telegram channel handle");

/** Bluesky handle or DID. */
export const actorPattern = z
  .string()
  .trim()
  .min(1, "actor must not be empty")
  .max(256, "actor must be 256 characters or fewer")
  .regex(/^(did:[a-z0-9:._%-]+|[a-zA-Z0-9._-]+(\.[a-zA-Z0-9._-]+)+)$/, "not a valid handle or DID");

// ─── Numeric primitives ────────────────────────────────────────────────────

/**
 * A bounded positive integer. Coerced because these arrive as JSON numbers or
 * as strings from query params, and both are legitimate here — this is a
 * representation difference, not a value change.
 */
export function positiveLimit(max: number, label = "limit") {
  return z.coerce
    .number({ invalid_type_error: `${label} must be a number` })
    .int(`${label} must be a whole number`)
    .positive(`${label} must be greater than zero`)
    .max(max, `${label} must be ${max} or less`);
}

/** A finite score. Rejects NaN and Infinity, which survive JSON.parse via strings. */
export function boundedScore(min: number, max: number, label = "value") {
  return z
    .number({ invalid_type_error: `${label} must be a number` })
    .finite(`${label} must be a finite number`)
    .min(min, `${label} must be at least ${min}`)
    .max(max, `${label} must be at most ${max}`);
}

// ─── Collections ───────────────────────────────────────────────────────────

export function boundedArray<S extends z.ZodTypeAny>(schema: S, max: number, label = "list") {
  return z.array(schema).max(max, `${label} must contain ${max} items or fewer`);
}

/** Default ceiling on a whole server-function payload: 256 KB. */
export const DEFAULT_MAX_PAYLOAD_BYTES = 262_144;

/**
 * Refinement capping the serialized size of a value.
 *
 * Attach with `.superRefine(jsonSizeLimit(n))`. Guards the disk-write paths,
 * where an unbounded array is a filesystem-fill primitive rather than merely a
 * slow request.
 */
export function jsonSizeLimit(maxBytes = DEFAULT_MAX_PAYLOAD_BYTES) {
  return (value: unknown, ctx: z.RefinementCtx) => {
    let size: number;
    try {
      size = JSON.stringify(value)?.length ?? 0;
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "payload is not serialisable" });
      return;
    }
    if (size > maxBytes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `payload is ${size} bytes; the limit is ${maxBytes}`,
      });
    }
  };
}

// ─── Host and URL safety ───────────────────────────────────────────────────

/**
 * Hosts that must never be reachable from a server-side fetch, whatever an
 * allowlist says. Cloud metadata first — it is the payload of every SSRF
 * proof-of-concept, and on Azure it fronts the managed identity this app uses
 * to read Key Vault.
 */
export const BLOCKED_HOST_PATTERNS: RegExp[] = [
  /^169\.254\./, // link-local, incl. 169.254.169.254 (cloud metadata)
  /^127\./, // loopback
  /^10\./, // RFC1918
  /^192\.168\./, // RFC1918
  /^172\.(1[6-9]|2\d|3[01])\./, // RFC1918
  /^0\./, // "this network"
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // CGNAT
  /^localhost$/i,
  /^\[?::1\]?$/,
  /^\[?f[cd][0-9a-f]{2}:/i, // unique-local IPv6
  /^\[?fe80:/i, // link-local IPv6
  /\.internal$/i,
  /\.local$/i,
  /\.localdomain$/i,
];

export function isBlockedHost(host: string): boolean {
  const value = host.trim().toLowerCase();
  return BLOCKED_HOST_PATTERNS.some((re) => re.test(value));
}

/**
 * Reduce a user-supplied "instance" string to a bare hostname.
 *
 * Strips scheme, userinfo, port, path, query and fragment. The `@` and `:port`
 * cases matter: the sanitiser this replaces stripped only the scheme and path,
 * so `169.254.169.254:80` and `evil.com@internal-host` both survived intact.
 */
export function bareHost(raw: string): string {
  let value = String(raw ?? "")
    .trim()
    .toLowerCase();
  if (!value) return "";
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, ""); // scheme
  value = value.split(/[/?#]/)[0]; // path, query, fragment
  const at = value.lastIndexOf("@");
  if (at !== -1) value = value.slice(at + 1); // userinfo
  // Port — bracketed IPv6 first, so a bare v6 address is not truncated.
  const bracketed = /^\[([^\]]+)\](?::\d{1,5})?$/.exec(value);
  if (bracketed) return bracketed[1];
  const firstColon = value.indexOf(":");
  if (firstColon !== -1 && firstColon === value.lastIndexOf(":")) {
    value = value.slice(0, firstColon);
  }
  return value;
}

/**
 * A hostname that must appear in `allowed`.
 *
 * `envExtraVar` lets a deployment widen the list without a code change, which
 * is the same "config, never code" principle the LLM endpoint follows. Entries
 * from the env are still passed through `isBlockedHost`, so widening cannot
 * re-open the metadata endpoint.
 */
export function hostAllowlist(
  allowed: readonly string[],
  envExtraVar?: string,
  env: Record<string, string | undefined> = process.env,
) {
  return z.string().superRefine((raw, ctx) => {
    const host = bareHost(raw);
    if (!host) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "host must not be empty" });
      return;
    }
    if (isBlockedHost(host)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "host resolves to a private, loopback or link-local address",
      });
      return;
    }
    if (!allowedHosts(allowed, envExtraVar, env).has(host)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "host is not on the permitted list for this source",
      });
    }
  });
}

/** The effective allowlist: compiled-in entries plus vetted env additions. */
export function allowedHosts(
  allowed: readonly string[],
  envExtraVar?: string,
  env: Record<string, string | undefined> = process.env,
): Set<string> {
  const set = new Set(allowed.map((h) => bareHost(h)).filter(Boolean));
  if (envExtraVar) {
    for (const extra of (env[envExtraVar] ?? "").split(",")) {
      const host = bareHost(extra);
      if (host && !isBlockedHost(host)) set.add(host);
    }
  }
  return set;
}

/**
 * An absolute https URL whose host is on the allowlist.
 *
 * NOT a complete SSRF defence, and the gap is worth naming: this validates the
 * host STRING, so a hostname that is allowlisted but resolves to 169.254.169.254
 * (DNS rebinding) still passes. Closing that needs egress policy on the
 * container, which is out of scope at zero budget. Recorded here so nobody
 * later reads this function as a guarantee it does not make.
 */
export function httpUrlWithHostAllowlist(
  allowed: readonly string[],
  envExtraVar?: string,
  env: Record<string, string | undefined> = process.env,
) {
  return z.string().superRefine((raw, ctx) => {
    let url: URL;
    try {
      url = new URL(String(raw).trim());
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be an absolute URL" });
      return;
    }
    if (url.protocol !== "https:") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must use https" });
      return;
    }
    if (url.username || url.password) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must not embed credentials" });
      return;
    }
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (isBlockedHost(host)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "host resolves to a private, loopback or link-local address",
      });
      return;
    }
    if (!allowedHosts(allowed, envExtraVar, env).has(host)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "host is not on the permitted list" });
    }
  });
}

/** An absolute http(s) URL with no host restriction, for analyst-supplied links. */
export const absoluteHttpUrl = z
  .string()
  .trim()
  .max(2048, "URL must be 2048 characters or fewer")
  .superRefine((raw, ctx) => {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must be an absolute URL" });
      return;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "must use http or https" });
    }
  });
