import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState, type FormEvent } from "react";
import { z } from "zod";
import { AlertCircle, ArrowRight, Lock, ShieldCheck, User } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { useDemoSession } from "@/components/demo-session";
import {
  DEMO_OPERATOR,
  DEMO_PASSWORD,
  safeRedirectTarget,
  verifyDemoCredentials,
} from "@/utils/demo-session";

/**
 * Sign-in screen — DEMO ONLY. This is not authentication.
 *
 * The credentials below are compared in the browser, which means they are
 * plainly readable in the client bundle by anyone who opens devtools. This
 * screen therefore provides NO security whatsoever: it is a demonstration of
 * the sign-in flow, not a gate.
 *
 * Two facts make that safe to ship, and both must stay true:
 *   1. It says so on screen, permanently and before any interaction, and it
 *      prints the demo credentials — a login that publishes its own password
 *      cannot be mistaken for a security control.
 *   2. NO route is gated. `__root.tsx` has no `beforeLoad`, so every page is
 *      reachable directly whether or not anyone "signs in" here. Signing in
 *      navigates to the dashboard; it does not grant access to anything,
 *      because nothing was ever withheld.
 *
 * Nothing is transmitted — there is no request, no session and no cookie.
 *
 * A real implementation — Prisma/SQLite, Argon2id, server-side sessions, RBAC
 * and an audit log — already exists in git at commit `214f0df`, held by branch
 * `backup/pre-auth-rollback` and tag `pre-auth-rollback-20260806`. If auth is
 * ever wanted, restore that rather than hardening this file.
 *
 * Two constraints to respect if this screen is ever wired up for real:
 *   - There are NO HTTP API routes. TanStack Start 1.168 exposes no
 *     `createServerFileRoute`, so `fetch("/api/auth/login")` cannot work.
 *     Auth goes through `createServerFn`, as `214f0df` did.
 *   - `src/start.ts` scopes CSRF to `handlerType === "serverFn"`, so a
 *     hand-rolled `/api/` route would sit outside that protection.
 *
 * Rendered without <AppShell>: the shell implies a session, and every other
 * route wraps itself in it individually, so omitting the import is all a
 * full-bleed page needs.
 */

interface LoginSearch {
  /** Where to return after signing in, supplied by the root demo gate. */
  redirect?: string;
}

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): LoginSearch => ({
    redirect: typeof search.redirect === "string" ? search.redirect : undefined,
  }),
  head: () => ({ meta: [{ title: "Secure Access — Sentinel AI" }] }),
  component: LoginPage,
});

const schema = z.object({
  operator: z.string().min(1, "Operator ID is required"),
  password: z.string().min(1, "Password is required"),
});

function LoginPage() {
  const navigate = useNavigate();
  const { redirect } = Route.useSearch();
  const { session, ready, signIn } = useDemoSession();

  const [operator, setOperator] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const [showPw, setShowPw] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Already signed in — don't show a sign-in form to someone who is past it.
  useEffect(() => {
    if (ready && session) navigate({ to: safeRedirectTarget(redirect), replace: true });
  }, [ready, session, redirect, navigate]);

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    const parsed = schema.safeParse({ operator, password });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Invalid input");
      return;
    }

    // A string comparison in the browser. No request and no delay — a
    // simulated "Authenticating…" pause would be theatre for a service that
    // does not exist.
    if (!verifyDemoCredentials(operator, password)) {
      setError("Invalid operator ID or password.");
      setPassword("");
      return;
    }

    signIn(operator, remember);

    // Never navigate to the raw search param: safeRedirectTarget rejects
    // absolute and protocol-relative URLs, so a crafted link cannot bounce a
    // freshly signed-in operator off-site.
    navigate({ to: safeRedirectTarget(redirect), replace: true });
  }

  return (
    <div className="relative flex min-h-screen flex-col bg-[#0a1220] text-[#eef2f8]">
      {/* classification bar */}
      <div className="border-b border-[#c79a3a]/30 bg-[#c79a3a]/10 py-1.5 text-center text-[11px] font-semibold tracking-[0.18em] text-[#cdd7e6]">
        UNCLASSIFIED // DEMONSTRATOR
      </div>

      {/* backdrop */}
      <div
        className="pointer-events-none fixed inset-0 opacity-40"
        style={{
          backgroundImage:
            "linear-gradient(rgba(120,150,190,.05) 1px,transparent 1px),linear-gradient(90deg,rgba(120,150,190,.05) 1px,transparent 1px)",
          backgroundSize: "44px 44px",
        }}
      />
      <div
        className="pointer-events-none fixed inset-0"
        style={{
          background:
            "radial-gradient(900px 500px at 78% -8%, rgba(59,130,246,.10), transparent 60%), radial-gradient(700px 500px at 10% 110%, rgba(16,185,129,.08), transparent 60%)",
        }}
      />

      <div className="relative z-10 flex flex-1 items-center justify-center p-6">
        <div className="w-full max-w-[412px] rounded-2xl border border-[#1b2942] bg-gradient-to-b from-[#111c30] to-[#0d1728] p-8 shadow-2xl">
          {/* brand */}
          <div className="mb-1.5 flex items-center gap-3">
            <div className="grid h-11 w-11 place-items-center rounded-xl border border-[#27436a] bg-gradient-to-br from-[#12304f] to-[#0d2138] shadow-[inset_0_0_14px_rgba(16,185,129,0.12)]">
              <ShieldCheck className="h-6 w-6 text-emerald-500" />
            </div>
            <div>
              <h1 className="text-xl font-extrabold tracking-wide">SENTINEL&nbsp;AI</h1>
              <div className="mt-0.5 text-[11px] font-semibold uppercase tracking-[0.16em] text-emerald-500">
                OSINT Intelligence Platform
              </div>
            </div>
          </div>

          <p className="mb-4 mt-3.5 text-[12.5px] leading-relaxed text-[#8ea0b8]">
            Secure access terminal. Sign in with your operator credentials to continue.
          </p>

          {/* Permanent, pre-interaction disclosure. Publishing the credentials
              is the point — it makes the screen unmistakably a demo, and it
              tells whoever is driving the demo what to type. Do not remove
              this while the sign-in remains a client-side string comparison. */}
          <div className="mb-4 rounded-lg border border-[#c79a3a]/35 bg-[#c79a3a]/10 px-3 py-2.5 text-[11.5px] leading-relaxed text-[#e2cf9f]">
            <span className="font-semibold">Demo sign-in — not real authentication.</span>{" "}
            Credentials are checked in the browser and no pages are restricted.
            <div className="mt-1.5 flex gap-3 font-mono text-[11px] text-[#f0e2bd]">
              <span>
                ID <span className="text-[#c79a3a]">{DEMO_OPERATOR}</span>
              </span>
              <span>
                PW <span className="text-[#c79a3a]">{DEMO_PASSWORD}</span>
              </span>
            </div>
          </div>

          {error && (
            <div
              role="alert"
              className="mb-4 flex items-center gap-2 rounded-lg border border-red-400/30 bg-red-400/10 px-3 py-2 text-[12.5px] text-red-200"
            >
              <AlertCircle className="h-4 w-4 shrink-0 text-red-400" />
              <span>{error}</span>
            </div>
          )}

          <form onSubmit={onSubmit} className="flex flex-col gap-4" autoComplete="off" noValidate>
            {/* Operator ID */}
            <div>
              <Label
                htmlFor="operator"
                className="mb-1.5 block text-[11.5px] font-semibold uppercase tracking-wide text-[#8ea0b8]"
              >
                Operator ID
              </Label>
              <div className="relative flex items-center">
                <User className="pointer-events-none absolute left-3 h-4 w-4 text-[#61748f]" />
                <Input
                  id="operator"
                  value={operator}
                  onChange={(e) => setOperator(e.target.value)}
                  placeholder="e.g. analyst.rsharma"
                  autoComplete="username"
                  className="border-[#22324a] bg-[#0b1524] pl-9 text-sm text-[#eef2f8] placeholder:text-[#4d607d] focus-visible:ring-blue-500/30"
                />
              </div>
            </div>

            {/* Password */}
            <div>
              <Label
                htmlFor="password"
                className="mb-1.5 block text-[11.5px] font-semibold uppercase tracking-wide text-[#8ea0b8]"
              >
                Password
              </Label>
              <div className="relative flex items-center">
                <Lock className="pointer-events-none absolute left-3 h-4 w-4 text-[#61748f]" />
                <Input
                  id="password"
                  type={showPw ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••••"
                  autoComplete="current-password"
                  className="border-[#22324a] bg-[#0b1524] pl-9 pr-14 text-sm text-[#eef2f8] placeholder:text-[#4d607d] focus-visible:ring-blue-500/30"
                />
                <button
                  type="button"
                  onClick={() => setShowPw((s) => !s)}
                  className="absolute right-2.5 px-1.5 py-1 text-[11px] tracking-wide text-[#61748f] hover:text-[#8ea0b8]"
                  tabIndex={-1}
                >
                  {showPw ? "HIDE" : "SHOW"}
                </button>
              </div>
            </div>

            <div className="-mt-1 flex items-center justify-between text-[12.5px]">
              <label className="flex cursor-pointer items-center gap-2 text-[#8ea0b8]">
                <Checkbox
                  checked={remember}
                  onCheckedChange={(v) => setRemember(Boolean(v))}
                  className="border-[#2a3b56] data-[state=checked]:border-emerald-600 data-[state=checked]:bg-emerald-600"
                />
                Remember this device
              </label>
              {/* A button, not an <a>: /auth/reset is not a route, so a real
                  link would 404. Says what it is instead of pretending. */}
              <button
                type="button"
                onClick={() => setError("Password recovery is not available in this demo.")}
                className="text-[#7fb0ff] hover:underline"
              >
                Forgot password?
              </button>
            </div>

            <Button
              type="submit"
              className="mt-1 flex h-11 items-center justify-center gap-2 bg-gradient-to-b from-emerald-500 to-emerald-700 text-sm font-bold tracking-wide text-[#04140d] shadow-[0_6px_18px_rgba(16,185,129,0.28)] hover:brightness-105"
            >
              <ArrowRight className="h-4 w-4" strokeWidth={2.4} />
              Sign in
            </Button>

            <p className="text-center text-[11.5px] text-[#61748f]">
              Multi-factor verification is not part of this demonstrator.
            </p>
          </form>

          {/* footer */}
          <div className="mt-5 border-t border-[#1b2942] pt-4">
            <div className="flex gap-2 text-[11px] leading-relaxed text-[#61748f]">
              <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#c79a3a]" />
              <span>
                Authorised personnel only. All access attempts and activity are monitored and
                logged. Unauthorised use is prohibited.
              </span>
            </div>
            <div className="mt-3 flex justify-between text-[10.5px] tracking-wide text-[#455873]">
              {/* Amber, not the comp's green "SYSTEM: NOMINAL" — that asserted
                  a health check nothing in this build performs. */}
              <span className="flex items-center gap-1.5">
                <span className="inline-block h-1.5 w-1.5 rounded-full bg-[#c79a3a] shadow-[0_0_8px_#c79a3a]" />
                DEMO MODE · NO AUTH SERVICE
              </span>
              <span>v1.0 · iDEX PS-18</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
