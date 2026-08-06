import { QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  redirect,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { type ReactNode } from "react";

import { AuthProvider } from "../components/auth-provider";
import { Toaster } from "../components/ui/sonner";
import appCss from "../styles.css?url";
import { I18nProvider } from "../i18n/i18n-context";
import { ensureAuth, isPasswordChangePath, isPublicPath } from "../lib/auth-client";
import type { RouterContext } from "../router";

/** Where an account with `mustChangePassword` is confined until it complies. */
const CHANGE_PASSWORD_PATH = "/change-password";

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          This page didn't load
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong on our end. You can try refreshing or head back home.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<RouterContext>()({
  /**
   * The single gate every navigation passes through.
   *
   * Placed on the root rather than duplicated across the 27 route files, and
   * placed in `beforeLoad` rather than in a component so an unauthenticated
   * visitor never renders the shell at all. This is a redirect for the user's
   * benefit — the actual protection is that every server function calls a
   * guard, so bypassing this changes nothing about what data can be read.
   */
  beforeLoad: async ({
    context,
    location,
  }): Promise<{ auth: Awaited<ReturnType<typeof ensureAuth>> }> => {
    const auth = await ensureAuth(context.queryClient);
    const pathname = location.pathname;

    if (!auth.user) {
      if (isPublicPath(pathname)) return { auth };

      throw redirect({
        to: "/login",
        // Carried so the user lands back where they were aiming once they
        // sign in, instead of always being dropped on the dashboard.
        search: { redirect: pathname === "/" ? undefined : pathname },
        replace: true,
      });
    }

    // Signed in: the login page has nothing left to offer.
    if (isPublicPath(pathname)) {
      throw redirect({ to: "/", replace: true });
    }

    // A forced password change is a wall, not a suggestion. The seeded admin
    // account ships with a documented password; without this it could keep
    // using it indefinitely by never visiting the change screen.
    if (auth.user.mustChangePassword && !isPasswordChangePath(pathname)) {
      throw redirect({ to: CHANGE_PASSWORD_PATH, replace: true });
    }

    return { auth };
  },

  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: "Sentinel AI — OSINT & Sentiment Intelligence Platform" },
      {
        name: "description",
        content:
          "Enterprise-grade AI-powered OSINT, social, and sentiment intelligence for security, defense, and brand teams.",
      },
      { name: "author", content: "Sentinel AI" },
      { property: "og:title", content: "Sentinel AI — OSINT & Sentiment Intelligence Platform" },
      {
        property: "og:description",
        content: "Enterprise-grade AI-powered OSINT, social, and sentiment intelligence.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
    links: [
      {
        rel: "stylesheet",
        href: appCss,
      },
      // SVG first — browsers that support it scale it cleanly at every size.
      // The .ico is the legacy fallback and is also what a bare /favicon.ico
      // request gets. Both render the same mark.
      { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
      { rel: "icon", href: "/favicon.ico", sizes: "32x32" },
      { rel: "apple-touch-icon", href: "/favicon-32.png" },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient, auth } = Route.useRouteContext();

  return (
    <QueryClientProvider client={queryClient}>
      {/* `auth` is already resolved by beforeLoad, so the provider starts with
          the real session and there is no signed-out flash on hydration. */}
      <AuthProvider initialState={auth}>
        <I18nProvider>
          {/* Required: nested routes render here. Removing <Outlet /> breaks all child routes. */}
          <Outlet />
          {/* Mounted here for the first time. The codebase already had ~25
              toast() calls across agents.tsx, vault.tsx, subjects.tsx and
              others that silently rendered nothing without it. */}
          <Toaster />
        </I18nProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
