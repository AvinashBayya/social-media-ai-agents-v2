import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { AlertTriangle, Loader2, Lock, ShieldCheck } from "lucide-react";
import { useState, type FormEvent } from "react";

import { useSetAuth } from "@/components/auth-provider";
import { safeRedirectTarget } from "@/lib/auth-client";
import { authErrorMessage } from "@/lib/auth-errors";
import { LoginSchema, fieldErrorsFrom } from "@/lib/auth-schemas";
import { login } from "@/server/auth/functions";

/**
 * Sign-in screen.
 *
 * Rendered without <AppShell> — the shell implies a session, and every other
 * route wraps itself in it individually, so simply omitting it is all that is
 * needed. Styling follows the route palette (hardcoded hex) rather than the
 * semantic tokens used in __root.tsx, so it looks native next to the rest of
 * the application.
 *
 * Form state is plain useState with a zod parse on submit, matching the
 * existing convention in subjects.tsx and settings.tsx. react-hook-form is
 * installed but unused anywhere in the app; introducing it for one form would
 * add a second pattern for no gain.
 */

interface LoginSearch {
  /** Path to return to after signing in, supplied by the root route guard. */
  redirect?: string;
}

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): LoginSearch => ({
    redirect: typeof search.redirect === "string" ? search.redirect : undefined,
  }),
  head: () => ({ meta: [{ title: "Sign in — Sentinel AI" }] }),
  component: LoginPage,
});

function LoginPage() {
  const navigate = useNavigate();
  const router = useRouter();
  const setAuth = useSetAuth();
  const { redirect } = Route.useSearch();

  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;

    setFormError(null);
    setFieldErrors({});

    const parsed = LoginSchema.safeParse({ identifier, password, remember });
    if (!parsed.success) {
      setFieldErrors(fieldErrorsFrom(parsed.error));
      return;
    }

    setSubmitting(true);
    try {
      const result = await login({ data: parsed.data });

      // A rejected credential comes back as data, not as a thrown error — the
      // framework's error serialiser keeps only `message`, so a throw would
      // lose the code and the field errors. See AuthResult in
      // src/server/auth/functions.ts.
      if (!result.ok) {
        // Field-level messages only ever come from a validation failure. A
        // rejected credential is reported against the form as a whole, never
        // against a specific field — pointing at "username" would confirm the
        // account exists, which is the enumeration leak the server avoids.
        if (result.fieldErrors) setFieldErrors(result.fieldErrors);
        setFormError(result.message);
        setPassword("");
        return;
      }

      // Seed the cache so the root guard sees the session immediately rather
      // than issuing another request as part of the navigation.
      setAuth(result.state);
      await router.invalidate();

      if (result.state.user?.mustChangePassword) {
        await navigate({ to: "/change-password", replace: true });
        return;
      }

      // Never navigate to the raw search parameter — `safeRedirectTarget`
      // rejects absolute and protocol-relative URLs, so a crafted link cannot
      // bounce a freshly signed-in user off-site.
      await navigate({ to: safeRedirectTarget(redirect), replace: true });
    } catch (error) {
      // Only genuine faults reach here: a dead server, a dropped connection.
      setFormError(authErrorMessage(error, "Sign-in failed. Try again."));
      setPassword("");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#0F172A] px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <span className="grid size-11 place-items-center rounded border border-[#3B82F6]/25 bg-[#3B82F6]/10 text-[#3B82F6]">
            <ShieldCheck className="size-5" />
          </span>
          <h1 className="mt-4 font-mono text-lg font-bold tracking-tight text-[#F3F4F6]">
            Sentinel AI
          </h1>
          <p className="mt-1 font-mono text-[11px] uppercase tracking-widest text-[#64748B]">
            Restricted system — authorised personnel
          </p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="rounded border border-[#263548] bg-[#111827] p-6"
          noValidate
        >
          <h2 className="font-mono text-xs font-bold uppercase tracking-wider text-[#94A3B8]">
            Sign in
          </h2>

          {formError ? (
            <div
              role="alert"
              className="mt-4 flex items-start gap-2 rounded border border-[#EF4444]/30 bg-[#EF4444]/5 p-3"
            >
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-[#EF4444]" />
              <p className="font-mono text-[11px] leading-relaxed text-[#FCA5A5]">{formError}</p>
            </div>
          ) : null}

          <div className="mt-4">
            <label
              htmlFor="identifier"
              className="block font-mono text-[10px] font-bold uppercase tracking-wider text-[#94A3B8]"
            >
              Username or email
            </label>
            <input
              id="identifier"
              name="identifier"
              type="text"
              autoComplete="username"
              autoFocus
              value={identifier}
              onChange={(event) => setIdentifier(event.target.value)}
              disabled={submitting}
              aria-invalid={Boolean(fieldErrors.identifier)}
              className="mt-1.5 w-full rounded border border-[#263548] bg-[#0F172A] px-3 py-2 font-mono text-sm text-[#F3F4F6] outline-none transition-colors placeholder:text-[#475569] focus:border-[#3B82F6] disabled:opacity-50"
            />
            {fieldErrors.identifier ? (
              <p className="mt-1 font-mono text-[10px] text-[#FCA5A5]">{fieldErrors.identifier}</p>
            ) : null}
          </div>

          <div className="mt-3">
            <label
              htmlFor="password"
              className="block font-mono text-[10px] font-bold uppercase tracking-wider text-[#94A3B8]"
            >
              Password
            </label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={submitting}
              aria-invalid={Boolean(fieldErrors.password)}
              className="mt-1.5 w-full rounded border border-[#263548] bg-[#0F172A] px-3 py-2 font-mono text-sm text-[#F3F4F6] outline-none transition-colors placeholder:text-[#475569] focus:border-[#3B82F6] disabled:opacity-50"
            />
            {fieldErrors.password ? (
              <p className="mt-1 font-mono text-[10px] text-[#FCA5A5]">{fieldErrors.password}</p>
            ) : null}
          </div>

          <label className="mt-4 flex cursor-pointer items-center gap-2 font-mono text-[11px] text-[#94A3B8]">
            <input
              type="checkbox"
              checked={remember}
              onChange={(event) => setRemember(event.target.checked)}
              disabled={submitting}
              className="size-3.5 accent-[#3B82F6]"
            />
            Keep me signed in for 30 days
          </label>

          <button
            type="submit"
            disabled={submitting}
            className="mt-5 flex w-full items-center justify-center gap-2 rounded bg-[#3B82F6] px-4 py-2 font-mono text-xs font-bold uppercase tracking-wider text-white transition-colors hover:bg-[#2563EB] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                Verifying
              </>
            ) : (
              <>
                <Lock className="size-3.5" />
                Sign in
              </>
            )}
          </button>
        </form>

        <p className="mt-4 text-center font-mono text-[10px] leading-relaxed text-[#475569]">
          Access is logged. Unauthorised use is an offence.
        </p>
      </div>
    </div>
  );
}
