import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useNavigate,
  useRouter,
  useRouterState,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, type ReactNode } from "react";

import appCss from "../styles.css?url";
import { I18nProvider } from "../i18n/i18n-context";
import { DemoSessionProvider, useDemoSession } from "../components/demo-session";
import { Toaster } from "../components/ui/sonner";

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

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
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

/**
 * Runs before first paint (a blocking script, no async/defer) to apply the
 * real stored theme to <html> ahead of hydration — mirrors
 * src/utils/theme.ts's getThemePreference()/resolveTheme() logic exactly
 * (an absent key means "never touched the toggle" and resolves to dark,
 * matching this app's pre-toggle behavior, rather than silently following
 * the OS preference for an existing user who never chose anything).
 * suppressHydrationWarning on <html> below is required alongside this:
 * server-rendered markup can never know the real client-side preference, so
 * the class this script applies will always differ from what SSR rendered,
 * by design — that's the flash this script exists to prevent, not a bug.
 */
const THEME_INIT_SCRIPT = `(function(){try{var v=localStorage.getItem("sentinel_theme");var dark=v==="light"?false:v==="system"?window.matchMedia("(prefers-color-scheme: dark)").matches:true;document.documentElement.classList.toggle("dark",dark);}catch(e){}})();`;

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

/** Reachable without a demo session. */
const PUBLIC_PATHS = new Set(["/login"]);

/**
 * Redirects to /login when there is no demo session.
 *
 * ⚠️ This is a UX flow, NOT a security boundary. The check runs in the browser
 * against localStorage, so it is bypassed by anyone who sets the key by hand or
 * simply disables JavaScript. Nothing behind it is protected — every route
 * still renders its own data, and the ~30 server functions remain callable by
 * a crafted request regardless of what this component decides. Do not add a
 * route here and consider it restricted.
 *
 * It waits for `ready` because the session lives in localStorage, which the
 * server cannot read: acting on the first render would bounce every signed-in
 * operator straight back to /login on a hard refresh.
 */
function DemoGate({ children }: { children: ReactNode }) {
  const { session, ready } = useDemoSession();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  const blocked = ready && !session && !PUBLIC_PATHS.has(pathname);

  useEffect(() => {
    if (!blocked) return;
    navigate({ to: "/login", search: { redirect: pathname }, replace: true });
  }, [blocked, pathname, navigate]);

  if (blocked) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0a1220] px-4">
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-[#61748f]">
          Redirecting to sign-in…
        </p>
      </div>
    );
  }

  return <>{children}</>;
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();

  return (
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
        <DemoSessionProvider>
          <DemoGate>
            {/* Required: nested routes render here. Removing <Outlet /> breaks all child routes. */}
            <Outlet />
          </DemoGate>
          {/*
            The app's entire success/failure channel. `sonner` was a dependency,
            `ui/sonner.tsx` exported <Toaster />, and 30 `toast.*` call sites
            across 9 files were writing to it — but nothing ever rendered it, so
            every message the app tried to show was silently dropped.

            The damaging case was vault.tsx: when SubtleCrypto is unavailable
            (plain HTTP on a non-localhost origin) evidence hashing fails and
            `toast.error("Evidence not added…")` fires. The analyst saw nothing
            at all, and the file was silently not added.

            It sits OUTSIDE DemoGate on purpose — /login raises toasts too, and
            the gate does not render its children while redirecting.
          */}
          <Toaster position="top-right" richColors closeButton />
        </DemoSessionProvider>
      </I18nProvider>
    </QueryClientProvider>
  );
}
