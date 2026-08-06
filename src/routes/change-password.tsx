import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { AlertTriangle, KeyRound, Loader2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";

import { useAuth, useSetAuth } from "@/components/auth-provider";
import { authErrorMessage } from "@/lib/auth-errors";
import { ChangePasswordSchema, PASSWORD_MIN, fieldErrorsFrom } from "@/lib/auth-schemas";
import { changePassword } from "@/server/auth/functions";

/**
 * Change your own password.
 *
 * Serves two situations with one screen: a voluntary change, and the forced
 * change the root guard confines a `mustChangePassword` account to. The copy
 * shifts between them, the behaviour does not.
 *
 * Rendered without <AppShell> deliberately — when the change is mandatory
 * there should be no navigation offering a way around it.
 */

export const Route = createFileRoute("/change-password")({
  head: () => ({ meta: [{ title: "Change password — Sentinel AI" }] }),
  component: ChangePasswordPage,
});

const RULES = [
  `At least ${PASSWORD_MIN} characters`,
  "An uppercase and a lowercase letter",
  "A digit and a symbol",
  "Must not contain your username or email",
];

function ChangePasswordPage() {
  const navigate = useNavigate();
  const router = useRouter();
  const setAuth = useSetAuth();
  const { user } = useAuth();

  const forced = user?.mustChangePassword ?? false;

  const [currentPassword, setCurrentPassword] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");

  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (submitting) return;

    setFormError(null);
    setFieldErrors({});

    if (password !== confirm) {
      setFieldErrors({ confirm: "The two passwords do not match." });
      return;
    }

    const parsed = ChangePasswordSchema.safeParse({ currentPassword, password });
    if (!parsed.success) {
      setFieldErrors(fieldErrorsFrom(parsed.error));
      return;
    }

    setSubmitting(true);
    try {
      const result = await changePassword({ data: parsed.data });

      // Returned rather than thrown, so `code` and `fieldErrors` survive the
      // wire — a wrong current password is an expected outcome here.
      if (!result.ok) {
        if (result.fieldErrors) setFieldErrors(result.fieldErrors);
        setFormError(result.message);
        setCurrentPassword("");
        return;
      }

      setAuth(result.state);
      await router.invalidate();

      toast.success("Password changed. Your other sessions have been signed out.");
      await navigate({ to: "/", replace: true });
    } catch (error) {
      setFormError(authErrorMessage(error, "Could not change the password."));
      setCurrentPassword("");
    } finally {
      setSubmitting(false);
    }
  }

  const inputClass =
    "mt-1.5 w-full rounded border border-[#263548] bg-[#0F172A] px-3 py-2 font-mono text-sm text-[#F3F4F6] outline-none transition-colors focus:border-[#3B82F6] disabled:opacity-50";
  const labelClass =
    "block font-mono text-[10px] font-bold uppercase tracking-wider text-[#94A3B8]";

  return (
    <div className="flex min-h-screen items-center justify-center bg-[#0F172A] px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center text-center">
          <span className="grid size-11 place-items-center rounded border border-[#F59E0B]/25 bg-[#F59E0B]/10 text-[#F59E0B]">
            <KeyRound className="size-5" />
          </span>
          <h1 className="mt-4 font-mono text-lg font-bold tracking-tight text-[#F3F4F6]">
            {forced ? "Set a new password" : "Change password"}
          </h1>
          {forced ? (
            <p className="mt-1 max-w-xs font-mono text-[11px] leading-relaxed text-[#64748B]">
              This account still uses its issued password. Choose your own before continuing.
            </p>
          ) : null}
        </div>

        <form
          onSubmit={handleSubmit}
          className="rounded border border-[#263548] bg-[#111827] p-6"
          noValidate
        >
          {formError ? (
            <div
              role="alert"
              className="mb-4 flex items-start gap-2 rounded border border-[#EF4444]/30 bg-[#EF4444]/5 p-3"
            >
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-[#EF4444]" />
              <p className="font-mono text-[11px] leading-relaxed text-[#FCA5A5]">{formError}</p>
            </div>
          ) : null}

          <div>
            <label htmlFor="currentPassword" className={labelClass}>
              Current password
            </label>
            <input
              id="currentPassword"
              type="password"
              autoComplete="current-password"
              autoFocus
              value={currentPassword}
              onChange={(event) => setCurrentPassword(event.target.value)}
              disabled={submitting}
              className={inputClass}
            />
            {fieldErrors.currentPassword ? (
              <p className="mt-1 font-mono text-[10px] text-[#FCA5A5]">
                {fieldErrors.currentPassword}
              </p>
            ) : null}
          </div>

          <div className="mt-3">
            <label htmlFor="password" className={labelClass}>
              New password
            </label>
            <input
              id="password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={submitting}
              className={inputClass}
            />
            {fieldErrors.password ? (
              <p className="mt-1 font-mono text-[10px] text-[#FCA5A5]">{fieldErrors.password}</p>
            ) : null}
          </div>

          <div className="mt-3">
            <label htmlFor="confirm" className={labelClass}>
              Confirm new password
            </label>
            <input
              id="confirm"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
              disabled={submitting}
              className={inputClass}
            />
            {fieldErrors.confirm ? (
              <p className="mt-1 font-mono text-[10px] text-[#FCA5A5]">{fieldErrors.confirm}</p>
            ) : null}
          </div>

          <ul className="mt-4 space-y-1">
            {RULES.map((rule) => (
              <li key={rule} className="font-mono text-[10px] leading-relaxed text-[#64748B]">
                — {rule}
              </li>
            ))}
          </ul>

          <button
            type="submit"
            disabled={submitting}
            className="mt-5 flex w-full items-center justify-center gap-2 rounded bg-[#3B82F6] px-4 py-2 font-mono text-xs font-bold uppercase tracking-wider text-white transition-colors hover:bg-[#2563EB] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                Saving
              </>
            ) : (
              "Update password"
            )}
          </button>
        </form>

        <p className="mt-4 text-center font-mono text-[10px] leading-relaxed text-[#475569]">
          Changing your password signs out your other devices.
        </p>
      </div>
    </div>
  );
}
