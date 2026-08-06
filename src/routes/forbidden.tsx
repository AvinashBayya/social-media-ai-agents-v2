import { Link, createFileRoute } from "@tanstack/react-router";
import { ShieldX } from "lucide-react";

import { useAuth } from "@/components/auth-provider";

/**
 * 403 — signed in, but the role does not permit what was requested.
 *
 * Distinct from the 404 page on purpose: telling someone a page exists but is
 * closed to them is more useful than pretending it is missing, and this is an
 * internal tool where the route list is not a secret. The denial itself is
 * already recorded in the audit log by the server-side guard that produced it.
 *
 * Layout mirrors NotFoundComponent in __root.tsx so the two feel like one
 * system, and renders outside <AppShell> because the shell implies access.
 */

export const Route = createFileRoute("/forbidden")({
  head: () => ({ meta: [{ title: "Access denied — Sentinel AI" }] }),
  component: ForbiddenPage,
});

function ForbiddenPage() {
  const { user } = useAuth();

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <span className="mx-auto grid size-12 place-items-center rounded border border-[#EF4444]/25 bg-[#EF4444]/10 text-[#EF4444]">
          <ShieldX className="size-6" />
        </span>

        <h1 className="mt-5 text-7xl font-bold text-foreground">403</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Access denied</h2>

        <p className="mt-2 text-sm text-muted-foreground">
          Your account does not have permission to view this page.
          {user ? (
            <>
              {" "}
              You are signed in as{" "}
              <span className="font-mono text-foreground" data-no-translate>
                {user.username}
              </span>{" "}
              with the{" "}
              <span className="font-mono text-foreground" data-no-translate>
                {user.role}
              </span>{" "}
              role.
            </>
          ) : null}
        </p>

        <p className="mt-2 text-xs text-muted-foreground">
          If you need access, ask an administrator to change your role.
        </p>

        <div className="mt-6 flex flex-wrap justify-center gap-2">
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
