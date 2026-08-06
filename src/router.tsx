import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";

import { SIGNED_OUT_STATE, type AuthState } from "./lib/auth-client";
import { routeTree } from "./routeTree.gen";

/**
 * Router context.
 *
 * `auth` is a placeholder here and is replaced by the root route's
 * `beforeLoad`, which resolves the real session before any route renders.
 * Declaring it on the context is what makes it available to every child
 * route's `beforeLoad` for role checks, and gives those checks a type.
 */
export interface RouterContext {
  queryClient: QueryClient;
  auth: AuthState;
}

export const getRouter = () => {
  const queryClient = new QueryClient();

  const router = createRouter({
    routeTree,
    context: { queryClient, auth: SIGNED_OUT_STATE } satisfies RouterContext,
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
  });

  return router;
};
