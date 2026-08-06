import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";

import {
  authQueryOptions,
  clearAuthCaches,
  setCachedAuth,
  SIGNED_OUT_STATE,
  type AuthState,
} from "@/lib/auth-client";
import { roleAtLeast, type Permission, type Role } from "@/lib/roles";
import { logout as logoutFn } from "@/server/auth/functions";

/**
 * Auth state for the component tree.
 *
 * Seeded from the root route's `beforeLoad`, which has already resolved the
 * session, then kept live by TanStack Query so a logout or a role change
 * propagates without a full reload. `initialState` is what prevents a
 * signed-in user seeing a flash of the signed-out shell on hydration.
 *
 * `can()` and `atLeast()` exist so components never compare role strings
 * inline — that pattern is how a permission check ends up subtly different in
 * one of fifteen places. They are UI affordances only; the server re-checks
 * every one of them.
 */

interface AuthContextValue {
  user: AuthState["user"];
  session: AuthState["session"];
  isAuthenticated: boolean;
  /** True while the session is being re-validated in the background. */
  isRefreshing: boolean;
  /** Does the current role hold this capability? */
  can: (permission: Permission) => boolean;
  /** Is the current role at least this one? */
  atLeast: (role: Role) => boolean;
  signOut: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({
  children,
  initialState,
}: {
  children: ReactNode;
  initialState: AuthState;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const { data, isFetching } = useQuery({
    ...authQueryOptions(),
    initialData: initialState,
  });

  const state = data ?? SIGNED_OUT_STATE;

  const can = useCallback(
    (permission: Permission) => state.user?.permissions.includes(permission) ?? false,
    [state.user],
  );

  const atLeast = useCallback(
    (role: Role) => (state.user ? roleAtLeast(state.user.role, role) : false),
    [state.user],
  );

  const signOut = useCallback(async () => {
    try {
      await logoutFn();
    } finally {
      // Runs even if the request failed. A logout that leaves the browser
      // holding cached intelligence data because the network blipped is worse
      // than one that clears optimistically — the server-side session is
      // revoked or it is not, and the client cannot fix that by keeping data.
      await clearAuthCaches(queryClient);
      await navigate({ to: "/login", replace: true });
    }
  }, [queryClient, navigate]);

  const refresh = useCallback(async () => {
    await queryClient.invalidateQueries({ queryKey: authQueryOptions().queryKey });
  }, [queryClient]);

  const value = useMemo<AuthContextValue>(
    () => ({
      user: state.user,
      session: state.session,
      isAuthenticated: state.user !== null,
      isRefreshing: isFetching,
      can,
      atLeast,
      signOut,
      refresh,
    }),
    [state.user, state.session, isFetching, can, atLeast, signOut, refresh],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used inside <AuthProvider>. It is mounted in __root.tsx.");
  }
  return context;
}

/** Update the cached session after login or a password change. */
export function useSetAuth() {
  const queryClient = useQueryClient();
  return useCallback((state: AuthState) => setCachedAuth(queryClient, state), [queryClient]);
}
