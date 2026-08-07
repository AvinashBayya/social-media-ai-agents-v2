import { z } from "zod";

/**
 * Demo session store — THIS IS NOT AUTHENTICATION.
 *
 * The credentials are compared in the browser and the "session" is a plain
 * localStorage record with no signature and no server involvement. Anyone can
 * mint one from devtools with a single assignment. It exists so the sign-in
 * flow, the operator chip and the sign-out path can be demonstrated end to
 * end; it withholds nothing and protects nothing.
 *
 * Every identifier here says `demo` on purpose. If a real auth layer ever
 * lands, this module should be deleted rather than hardened — the shape of a
 * client-side session is wrong for the job. The real implementation already
 * exists in git at `214f0df` (branch `backup/pre-auth-rollback`).
 *
 * Pure and DOM-light on purpose: the parsing and credential rules are plain
 * functions so `bun test` can cover them, matching the convention in the rest
 * of `src/utils/`. Only the read/write helpers touch `window`.
 */

/** Public demo credentials. Never put a real credential here — it ships to the browser. */
export const DEMO_OPERATOR = "admin@";
export const DEMO_PASSWORD = "admin@123";

/** Matches the existing `sentinel_*` localStorage convention. */
export const DEMO_SESSION_KEY = "sentinel_demo_session";

/**
 * Broadcast on every change so components in other trees re-read the store.
 * Mirrors the existing `sentinel_target_changed` pattern in app-shell.tsx —
 * the native `storage` event does not fire in the tab that made the write.
 */
export const DEMO_SESSION_EVENT = "sentinel_demo_session_changed";

export const DemoSessionSchema = z.object({
  operator: z.string().min(1),
  displayName: z.string().min(1),
  email: z.string().min(1),
  role: z.string().min(1),
  signedInAt: z.string().min(1),
  remember: z.boolean(),
});

export type DemoSession = z.infer<typeof DemoSessionSchema>;

/**
 * A constant-shaped profile for the one demo operator. Not a user record —
 * there is no user store, and inventing extra accounts would imply one.
 */
export function demoProfileFor(operator: string): Omit<DemoSession, "signedInAt" | "remember"> {
  return {
    operator,
    displayName: "Administrator",
    email: "admin@sentinel.local",
    role: "Administrator",
  };
}

/**
 * Credential check. Trims the operator because the field is free text and a
 * trailing space is a paste artefact, not a different account. The password is
 * compared exactly.
 */
export function verifyDemoCredentials(operator: string, password: string): boolean {
  return operator.trim() === DEMO_OPERATOR && password === DEMO_PASSWORD;
}

export function createDemoSession(
  operator: string,
  remember: boolean,
  now: string = new Date().toISOString(),
): DemoSession {
  return { ...demoProfileFor(operator.trim()), signedInAt: now, remember };
}

/**
 * Parses a stored record. Returns null for anything malformed rather than
 * throwing or repairing it — a half-readable session should log the operator
 * out, not resurrect a partial identity.
 */
export function parseDemoSession(raw: string | null): DemoSession | null {
  if (!raw) return null;
  try {
    const parsed = DemoSessionSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Rejects anything that could bounce a signed-in operator off-site: absolute
 * URLs, protocol-relative `//host`, and backslash variants browsers normalise
 * to a host. Only a same-origin absolute path is allowed through.
 */
export function safeRedirectTarget(target: string | undefined, fallback = "/"): string {
  if (!target) return fallback;
  if (!target.startsWith("/")) return fallback;
  if (target.startsWith("//") || target.startsWith("/\\")) return fallback;
  return target;
}

// ── Storage helpers (client only) ──────────────────────────────────────────

export function readDemoSession(): DemoSession | null {
  if (typeof window === "undefined") return null;
  try {
    return parseDemoSession(window.localStorage.getItem(DEMO_SESSION_KEY));
  } catch {
    return null;
  }
}

export function writeDemoSession(session: DemoSession): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(DEMO_SESSION_KEY, JSON.stringify(session));
  } catch {
    // Private-mode quota failures are not worth breaking sign-in over; the
    // session simply does not persist across reloads.
  }
  window.dispatchEvent(new CustomEvent(DEMO_SESSION_EVENT));
}

export function clearDemoSession(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(DEMO_SESSION_KEY);
  } catch {
    // ignore
  }
  window.dispatchEvent(new CustomEvent(DEMO_SESSION_EVENT));
}
