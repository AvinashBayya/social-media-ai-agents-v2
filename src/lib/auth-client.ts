import { queryOptions, type QueryClient } from "@tanstack/react-query";

import { fetchSession, type AuthState } from "@/server/auth/functions";

/**
 * Client-side auth state.
 *
 * The session is fetched through TanStack Query rather than directly in the
 * root route's `beforeLoad`. `beforeLoad` runs on every navigation, so a bare
 * call there would mean a round trip per page change; going through the query
 * cache makes it one fetch that every subsequent navigation reads from memory,
 * and gives login/logout a single, explicit way to invalidate it.
 *
 * Importing `fetchSession` here is safe in browser code: the TanStack Start
 * plugin replaces a server function's body with an RPC stub in the client
 * bundle, so none of the server-side auth module is shipped.
 *
 * Everything here is presentation. A tampered client can set any state it
 * likes and gain nothing — the guards in src/server/auth/guards.ts run on the
 * server and are the only thing that actually grants access.
 */

export const SIGNED_OUT_STATE: AuthState = { user: null, session: null };

export const authQueryOptions = () =>
  queryOptions({
    queryKey: ["auth", "session"] as const,
    queryFn: ({ signal }) => fetchSession({ signal }),
    // The server is re-consulted on every server-function call anyway, so a
    // short window of staleness costs nothing but saves a request per
    // navigation. Login and logout invalidate explicitly rather than waiting.
    staleTime: 30_000,
    // Never retry: a failure here means "not signed in", and retrying would
    // just delay the redirect to the login page.
    retry: false,
  });

/** Read the cached session without triggering a fetch. */
export function readCachedAuth(queryClient: QueryClient): AuthState {
  return queryClient.getQueryData(authQueryOptions().queryKey) ?? SIGNED_OUT_STATE;
}

/** Fetch the session, reusing the cached value when it is still fresh. */
export async function ensureAuth(queryClient: QueryClient): Promise<AuthState> {
  try {
    return await queryClient.ensureQueryData(authQueryOptions());
  } catch {
    // `fetchSession` is written not to throw for the signed-out case, so this
    // is a transport or server fault. Treating it as signed-out sends the user
    // to the login page, which is the correct failure mode — the alternative
    // is rendering the app shell around data that will not load.
    return SIGNED_OUT_STATE;
  }
}

/** Replace the cached session — used after login, logout and password change. */
export function setCachedAuth(queryClient: QueryClient, state: AuthState): void {
  queryClient.setQueryData(authQueryOptions().queryKey, state);
}

/**
 * Drop every cached query, not just the session.
 *
 * Called on logout. Loader and query caches hold intelligence data fetched
 * under the previous identity; leaving them in memory would let the next
 * person to sign in on the same browser tab see the previous analyst's
 * results before their own first fetch resolves.
 */
export async function clearAuthCaches(queryClient: QueryClient): Promise<void> {
  setCachedAuth(queryClient, SIGNED_OUT_STATE);
  queryClient.clear();
}

export type { AuthState };

// ─── Route classification ──────────────────────────────────────────────────

/**
 * Routes reachable without a session.
 *
 * An allowlist, not a blocklist. A route added to src/routes/ is protected by
 * default and making it public requires a deliberate edit here — the reverse
 * arrangement silently exposes whatever someone forgets to list.
 */
const PUBLIC_PATHS = new Set(["/login"]);

/**
 * Reachable while signed in but pending a forced password change. Anything
 * else redirects to the change screen until the flag clears.
 */
const PASSWORD_CHANGE_PATH = "/change-password";

/** Strip a trailing slash so "/login/" and "/login" classify identically. */
function normalisePath(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
}

export function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.has(normalisePath(pathname));
}

export function isPasswordChangePath(pathname: string): boolean {
  return normalisePath(pathname) === PASSWORD_CHANGE_PATH;
}

/**
 * Validate the `redirect` search parameter before navigating to it.
 *
 * Only same-origin absolute paths are honoured. Echoing an arbitrary value
 * back would be an open redirect: a link that lands on the genuine login page
 * and then bounces to an attacker's replica once the user signs in.
 */
export function safeRedirectTarget(candidate: string | undefined, fallback = "/"): string {
  if (!candidate || !candidate.startsWith("/")) return fallback;

  // "//host" and "/\host" are protocol-relative URLs, not local paths.
  if (candidate.startsWith("//") || candidate.startsWith("/\\")) return fallback;

  // Bouncing back to the login page would loop.
  const [path] = candidate.split("?");
  if (isPublicPath(path ?? "")) return fallback;

  return candidate;
}
